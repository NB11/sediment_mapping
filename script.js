let map;

// Initialize map
function initMap() {
    map = new maplibregl.Map({
        container: 'map-view',
        style: {
            version: 8,
            sources: {
                'osm-tiles': {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '© OpenStreetMap contributors'
                },
                'satellite-tiles': {
                    type: 'raster',
                    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                    tileSize: 256,
                    attribution: '© Esri'
                }
            },
            layers: [
                {
                    id: 'satellite-layer',
                    type: 'raster',
                    source: 'satellite-tiles',
                    minzoom: 0,
                    maxzoom: 19
                }
            ]
        },
        center: [15, 20], // Center on Africa, shifted right for widgets
        zoom: 1.5,
        maxZoom: 16.4, // MAXIMUM ZOOM LIMIT - Change this value to adjust how far users can zoom in (higher = more zoom)
        antialias: true
    });

    // Add custom base map switcher control first (will be on top)
    addBaseMapSwitcher();
    
    // Add navigation controls (will be below switcher)
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // Wait for map to load before adding data
    map.on('load', () => {
        loadSaharaGeoJSON();
        setupEventHandlers();
    });
}

// Calculate polygon area to determine winding order
function calculatePolygonArea(ring) {
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        area += ring[i][0] * ring[i + 1][1];
        area -= ring[i + 1][0] * ring[i][1];
    }
    return area / 2;
}

// Ensure ring is counter-clockwise (positive area)
function ensureCounterClockwise(ring) {
    const area = calculatePolygonArea(ring);
    return area > 0 ? ring : ring.reverse();
}

// Ensure ring is clockwise (negative area) - for holes
function ensureClockwise(ring) {
    const area = calculatePolygonArea(ring);
    return area < 0 ? ring : ring.reverse();
}

// Create inverse polygon (world minus Sahara) for masking
function createInversePolygon(saharaGeoJSON) {
    // Create a world polygon covering the entire globe (counter-clockwise)
    const worldPolygon = [
        [-180, -90],
        [-180, 90],
        [180, 90],
        [180, -90],
        [-180, -90]
    ];
    
    // Extract Sahara polygons as holes (must be clockwise)
    const holes = [];
    saharaGeoJSON.features.forEach(feature => {
        if (feature.geometry.type === 'MultiPolygon') {
            feature.geometry.coordinates.forEach(polygon => {
                // First ring of each polygon is the outer boundary
                polygon.forEach((ring, index) => {
                    if (index === 0) {
                        // Ensure clockwise for hole
                        const holeRing = ensureClockwise([...ring]);
                        holes.push(holeRing);
                    }
                });
            });
        } else if (feature.geometry.type === 'Polygon') {
            // First ring is outer boundary - make it clockwise for hole
            const holeRing = ensureClockwise([...feature.geometry.coordinates[0]]);
            holes.push(holeRing);
        }
    });
    
    return {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [worldPolygon, ...holes]
            },
            properties: {}
        }]
    };
}

// Load Sahara GeoJSON data
async function loadSaharaGeoJSON() {
    try {
        const response = await fetch('Sahara desert.geojson');
        const geoJsonData = await response.json();
        
        // Transform coordinates from EPSG:3857 to WGS84 if needed
        const transformedGeoJSON = transformGeoJSON(geoJsonData);
        
        // Create inverse polygon for masking
        const maskGeoJSON = createInversePolygon(transformedGeoJSON);
        
        // Remove existing sources/layers if present
        if (map.getLayer('world-mask')) {
            map.removeLayer('world-mask');
        }
        if (map.getSource('sahara-source')) {
            map.removeSource('sahara-source');
        }
        if (map.getSource('world-mask-source')) {
            map.removeSource('world-mask-source');
        }
        
        // Add mask source (world minus Sahara)
        map.addSource('world-mask-source', {
            type: 'geojson',
            data: maskGeoJSON
        });
        
        // Add grey mask layer (everything outside Sahara)
        map.addLayer({
            id: 'world-mask',
            type: 'fill',
            source: 'world-mask-source',
            paint: {
                'fill-color': '#6b7280', // Grey color
                'fill-opacity': 0.75
            }
        });
        
        // Add Sahara source (for interactions only)
        map.addSource('sahara-source', {
            type: 'geojson',
            data: transformedGeoJSON
        });
        
        // Calculate bounds and set as maxBounds to restrict panning
        const bounds = new maplibregl.LngLatBounds();
        transformedGeoJSON.features.forEach(feature => {
            if (feature.geometry.type === 'MultiPolygon') {
                feature.geometry.coordinates.forEach(polygon => {
                    polygon.forEach(ring => {
                        ring.forEach(coord => {
                            bounds.extend(coord);
                        });
                    });
                });
            } else if (feature.geometry.type === 'Polygon') {
                feature.geometry.coordinates.forEach(ring => {
                    ring.forEach(coord => {
                        bounds.extend(coord);
                    });
                });
            }
        });
        
        // Expand bounds by approximately 1000km (about 9 degrees)
        const expandedBounds = new maplibregl.LngLatBounds(
            [bounds.getWest() - 9, bounds.getSouth() - 9],
            [bounds.getEast() + 9, bounds.getNorth() + 9]
        );
        
        // Set maxBounds to restrict panning with some freedom
        map.setMaxBounds(expandedBounds);
        
        // Fit bounds to show the Sahara
        fitSaharaBounds(transformedGeoJSON);
        
        // Load ALOS PALSAR raster layer if available
        loadALOSRaster();
        
    } catch (error) {
        console.error('Error loading Sahara GeoJSON:', error);
        alert('Error loading Sahara desert data. Please check the console for details.');
    }
}

// Load ALOS PALSAR raster layer (PNG with bounds JSON)
// To use this: 
// 1. Run data_processing/export_for_webmap.py to create PNG and bounds JSON
// 2. Place files in data/ folder
// 3. This function will automatically load them
async function loadALOSRaster() {
    try {
        // Load bounds JSON file
        const boundsResponse = await fetch('data/alos_palsar_kufra_basin_bounds.json');
        if (!boundsResponse.ok) {
            console.log('ALOS PALSAR data not found, skipping...');
            return;
        }
        
        const boundsData = await boundsResponse.json();
        const coordinates = boundsData.geometry.coordinates[0];
        
        // Extract corner coordinates [lng, lat]
        const topLeft = coordinates[0];
        const topRight = coordinates[1];
        const bottomRight = coordinates[2];
        const bottomLeft = coordinates[3];
        
        // Add image source with 4 corner coordinates
        map.addSource('alos-palsar', {
            type: 'image',
            url: 'data/alos_palsar_kufra_basin.png',
            coordinates: [
                topLeft,     // top-left [lng, lat]
                topRight,    // top-right [lng, lat]
                bottomRight, // bottom-right [lng, lat]
                bottomLeft   // bottom-left [lng, lat]
            ]
        });
        
        // Add raster layer
        map.addLayer({
            id: 'alos-palsar-layer',
            type: 'raster',
            source: 'alos-palsar',
            paint: {
                'raster-opacity': 0.7
            }
        }, 'world-mask'); // Add before mask layer
        
        console.log('✅ ALOS PALSAR layer loaded successfully');
        
    } catch (error) {
        console.log('ALOS PALSAR data not available:', error.message);
    }
}

// Transform coordinates from Web Mercator (EPSG:3857) to WGS84 (EPSG:4326)
function transformGeoJSON(geoJson) {
    // Check if coordinates are already in WGS84 (between -180 and 180 for longitude)
    const firstCoord = geoJson.features[0].geometry.coordinates[0][0][0];
    
    // If coordinates are in Web Mercator (large numbers), transform them
    if (Math.abs(firstCoord[0]) > 180 || Math.abs(firstCoord[1]) > 90) {
        return transformCoordinates(geoJson);
    }
    
    return geoJson;
}

// Transform Web Mercator to WGS84
function transformCoordinates(geoJson) {
    const transformed = JSON.parse(JSON.stringify(geoJson));
    
    function transformPoint(coord) {
        const x = coord[0];
        const y = coord[1];
        const lng = (x / 20037508.34) * 180;
        let lat = (y / 20037508.34) * 180;
        lat = (Math.atan(Math.exp((lat * Math.PI) / 180)) * 360) / Math.PI - 90;
        return [lng, lat];
    }
    
    function transformCoordinatesRecursive(coords) {
        if (typeof coords[0] === 'number') {
            return transformPoint(coords);
        }
        return coords.map(transformCoordinatesRecursive);
    }
    
    transformed.features.forEach(feature => {
        if (feature.geometry.type === 'MultiPolygon') {
            feature.geometry.coordinates = feature.geometry.coordinates.map(polygon =>
                polygon.map(ring => ring.map(transformCoordinatesRecursive))
            );
        } else if (feature.geometry.type === 'Polygon') {
            feature.geometry.coordinates = feature.geometry.coordinates.map(ring =>
                ring.map(transformCoordinatesRecursive)
            );
        }
    });
    
    return transformed;
}

// Fit map bounds to show the Sahara desert
function fitSaharaBounds(geoJson) {
    const bounds = new maplibregl.LngLatBounds();
    
    geoJson.features.forEach(feature => {
        if (feature.geometry.type === 'MultiPolygon') {
            feature.geometry.coordinates.forEach(polygon => {
                polygon.forEach(ring => {
                    ring.forEach(coord => {
                        bounds.extend(coord);
                    });
                });
            });
        } else if (feature.geometry.type === 'Polygon') {
            feature.geometry.coordinates.forEach(ring => {
                ring.forEach(coord => {
                    bounds.extend(coord);
                });
            });
        }
    });
    
    map.fitBounds(bounds, {
        padding: { top: 50, bottom: 50, left: 360, right: 50 }, // Extra left padding for widgets
        duration: 2000,
        maxZoom: 5
    });
}

// Point in polygon check
function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        const intersect = ((yi > point[1]) !== (yj > point[1])) &&
            (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Check if point is inside any Sahara polygon
function isPointInSahara(lng, lat, saharaGeoJSON) {
    const point = [lng, lat];
    
    for (const feature of saharaGeoJSON.features) {
        if (feature.geometry.type === 'MultiPolygon') {
            for (const polygon of feature.geometry.coordinates) {
                // Check outer ring (first ring)
                if (polygon.length > 0 && pointInPolygon(point, polygon[0])) {
                    return true;
                }
            }
        } else if (feature.geometry.type === 'Polygon') {
            // Check outer ring (first ring)
            if (feature.geometry.coordinates.length > 0 && 
                pointInPolygon(point, feature.geometry.coordinates[0])) {
                return true;
            }
        }
    }
    return false;
}

// Setup event handlers
function setupEventHandlers() {
    // Click handler for entire map - check if clicking inside Sahara
    map.on('click', (e) => {
        const source = map.getSource('sahara-source');
        if (source && source._data) {
            const isInside = isPointInSahara(e.lngLat.lng, e.lngLat.lat, source._data);
            
            // No action on click - widget removed
        }
    });
    
    
    // Geological domains button
    document.getElementById('geological-domains-btn').addEventListener('click', () => {
        showImagePopup();
    });
    
    // Close popup handlers
    const popup = document.getElementById('image-popup');
    const popupClose = popup.querySelector('.popup-close');
    const popupOverlay = popup.querySelector('.popup-overlay');
    
    popupClose.addEventListener('click', () => {
        hideImagePopup();
    });
    
    popupOverlay.addEventListener('click', () => {
        hideImagePopup();
    });
    
    // Close popup on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !popup.classList.contains('hidden')) {
            hideImagePopup();
        }
    });
    
}

// Show image popup
function showImagePopup() {
    const popup = document.getElementById('image-popup');
    popup.classList.remove('hidden');
}

// Hide image popup
function hideImagePopup() {
    const popup = document.getElementById('image-popup');
    popup.classList.add('hidden');
}

// Display feature information in floating widget
function displayFeatureInfo(feature) {
    const infoDiv = document.getElementById('feature-info');
    const contentDiv = document.getElementById('feature-content');
    
    const props = feature.properties;
    let html = '';
    
    if (props.NAME) {
        html += `<p><strong>Name:</strong> ${props.NAME}</p>`;
    }
    if (props.NAME_EN) {
        html += `<p><strong>English Name:</strong> ${props.NAME_EN}</p>`;
    }
    if (props.REGION) {
        html += `<p><strong>Region:</strong> ${props.REGION}</p>`;
    }
    if (props.LABEL) {
        html += `<p><strong>Label:</strong> ${props.LABEL}</p>`;
    }
    if (props.FEATURECLA) {
        html += `<p><strong>Feature Class:</strong> ${props.FEATURECLA}</p>`;
    }
    
    contentDiv.innerHTML = html;
    infoDiv.classList.remove('hidden');
}

// Hide feature information
function hideFeatureInfo() {
    document.getElementById('feature-info').classList.add('hidden');
}

// SVG icons for base map switcher
const satelliteIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/>
    <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.34 6.34l1.41 1.41M16.24 16.24l1.41 1.41M6.34 17.66l1.41-1.41M16.24 7.76l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="2.5" fill="currentColor"/>
</svg>`;

const osmIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="3" width="7" height="7" stroke="currentColor" stroke-width="2" fill="none"/>
    <rect x="14" y="3" width="7" height="7" stroke="currentColor" stroke-width="2" fill="none"/>
    <rect x="3" y="14" width="7" height="7" stroke="currentColor" stroke-width="2" fill="none"/>
    <rect x="14" y="14" width="7" height="7" stroke="currentColor" stroke-width="2" fill="none"/>
    <line x1="6.5" y1="3" x2="6.5" y2="10" stroke="currentColor" stroke-width="1.5"/>
    <line x1="3" y1="6.5" x2="10" y2="6.5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="17.5" y1="3" x2="17.5" y2="10" stroke="currentColor" stroke-width="1.5"/>
    <line x1="14" y1="6.5" x2="21" y2="6.5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="6.5" y1="14" x2="6.5" y2="21" stroke="currentColor" stroke-width="1.5"/>
    <line x1="3" y1="17.5" x2="10" y2="17.5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="17.5" y1="14" x2="17.5" y2="21" stroke="currentColor" stroke-width="1.5"/>
    <line x1="14" y1="17.5" x2="21" y2="17.5" stroke="currentColor" stroke-width="1.5"/>
</svg>`;

// Custom base map switcher control
function addBaseMapSwitcher() {
    const BaseMapSwitcher = function(options) {
        this.currentMap = 'satellite'; // Default to satellite
    };
    
    BaseMapSwitcher.prototype.onAdd = function(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group base-map-switcher';
        
        const button = document.createElement('button');
        button.className = 'base-map-btn';
        button.innerHTML = satelliteIcon;
        button.setAttribute('aria-label', 'Switch base map');
        button.setAttribute('title', 'Switch base map');
        
        button.addEventListener('click', () => {
            if (this.currentMap === 'satellite') {
                this.currentMap = 'osm';
                button.innerHTML = osmIcon;
                switchBaseMap('osm');
            } else {
                this.currentMap = 'satellite';
                button.innerHTML = satelliteIcon;
                switchBaseMap('satellite');
            }
        });
        
        this._button = button; // Store reference
        this._container.appendChild(button);
        return this._container;
    };
    
    BaseMapSwitcher.prototype.onRemove = function() {
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
    };
    
    map.addControl(new BaseMapSwitcher(), 'top-right');
}

// Switch base map layer
function switchBaseMap(layerType) {
    const isSatellite = layerType === 'satellite';
    
    // Remove existing base layer
    if (map.getLayer('osm-tiles-layer')) {
        map.removeLayer('osm-tiles-layer');
    }
    if (map.getLayer('satellite-layer')) {
        map.removeLayer('satellite-layer');
    }
    
    // Add new base layer (before mask layer)
    map.addLayer({
        id: isSatellite ? 'satellite-layer' : 'osm-tiles-layer',
        type: 'raster',
        source: isSatellite ? 'satellite-tiles' : 'osm-tiles',
        minzoom: 0,
        maxzoom: 19
    }, 'world-mask'); // Insert before mask layer
}

// Initialize map when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMap);
} else {
    initMap();
}

