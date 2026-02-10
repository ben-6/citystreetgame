import { state } from '../state.js';
import { getLargestPolygon } from '../utils/geo.js';

// --- MAP INITIALIZATION ---
export function initMap() {
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
    
    // Disable telemetry to prevent ad blocker errors
    if (mapboxgl.setRTLTextPlugin) {
        mapboxgl.setRTLTextPlugin = () => {}; // Stub for RTL text plugin
    }

    state.map = new mapboxgl.Map({
        container: 'map',
        style: 'mapbox://styles/mapbox/dark-v11',
        center: state.GAME_CENTER,
        zoom: 12,
        attributionControl: false
    });

    state.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    state.map.addControl(new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true
    }), 'top-right');

    state.map.on('load', () => {
        console.log('Map loaded');
    });

    state.map.on('style.load', () => {
        const layers = state.map.getStyle().layers;
        for (const layer of layers) {
            if (layer.id.includes('label')) {
                state.map.setLayoutProperty(layer.id, 'visibility', 'none');
            }
        }
    });
}

export function setupCityMapLayers(boundaries, lat, lng) {
    if (!state.map) return;
    
    ['city-boundary-fill', 'city-boundary-line', 'streets-unfound', 'streets-found', 'street-highlight'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
    });
    ['city-boundary', 'streets', 'street-highlight-source'].forEach(id => {
        if (state.map.getSource(id)) state.map.removeSource(id);
    });

    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) return;
    
    state.map.addSource('city-boundary', { 
        type: 'geojson', 
        data: { type: 'Feature', geometry: mainBoundary, properties: {} } 
    });
    state.map.addLayer({ 
        id: 'city-boundary-fill', 
        type: 'fill', 
        source: 'city-boundary', 
        paint: { 'fill-color': '#00c8ff', 'fill-opacity': 0.1 } 
    });
    state.map.addLayer({ 
        id: 'city-boundary-line', 
        type: 'line', 
        source: 'city-boundary', 
        paint: { 'line-color': '#00c8ff', 'line-width': 2, 'line-opacity': 0.8 } 
    });
    
    state.map.addSource('streets', { type: 'geojson', data: state.streetData });
    state.map.addLayer({ 
        id: 'streets-unfound', 
        type: 'line', 
        source: 'streets', 
        paint: { 
            'line-color': '#ffffff', 
            'line-width': [
                'case',
                ['==', ['get', 'type'], 'major'], 6,
                ['==', ['get', 'type'], 'primary'], 5,
                ['==', ['get', 'type'], 'secondary'], 4,
                ['==', ['get', 'type'], 'tertiary'], 3,
                2.5
            ], 
            'line-opacity': document.getElementById('show-unfound-toggle')?.checked ? 0.2 : 0 
        } 
    });
    state.map.addLayer({ 
        id: 'streets-found', 
        type: 'line', 
        source: 'streets', 
        paint: { 
            'line-color': '#00c8ff', 
            'line-width': [
                'case',
                ['==', ['get', 'type'], 'major'], 7,
                ['==', ['get', 'type'], 'primary'], 6,
                ['==', ['get', 'type'], 'secondary'], 5,
                ['==', ['get', 'type'], 'tertiary'], 4,
                3
            ], 
            'line-opacity': 0 
        } 
    });
    
    state.map.addSource('street-highlight-source', { 
        type: 'geojson', 
        data: { type: 'FeatureCollection', features: [] } 
    });
    state.map.addLayer({ 
        id: 'street-highlight', 
        type: 'line', 
        source: 'street-highlight-source', 
        paint: { 
            'line-color': '#ff6464', 
            'line-width': 6, 
            'line-opacity': 0.8 
        } 
    });
    
    setupStreetHoverEvents();
    
    const coords = mainBoundary.coordinates[0];
    if (coords.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        coords.forEach(coord => bounds.extend(coord));
        state.map.fitBounds(bounds, { padding: 50, duration: 1500 });
    }
}

export function setupCityPreview(boundaries) {
    ['city-boundary-fill', 'city-boundary-line'].forEach(id => {
        if (state.map.getLayer(id)) state.map.removeLayer(id);
    });
    if (state.map.getSource('city-boundary')) state.map.removeSource('city-boundary');

    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) return;

    state.map.addSource('city-boundary', { 
        type: 'geojson', 
        data: { type: 'Feature', geometry: mainBoundary, properties: {} } 
    });
    state.map.addLayer({ 
        id: 'city-boundary-fill', 
        type: 'fill', 
        source: 'city-boundary', 
        paint: { 'fill-color': '#ffa500', 'fill-opacity': 0.15 } 
    });
    state.map.addLayer({ 
        id: 'city-boundary-line', 
        type: 'line', 
        source: 'city-boundary', 
        paint: { 'line-color': '#ffa500', 'line-width': 3, 'line-opacity': 0.8 } 
    });
}

// --- STREET HIGHLIGHTING ---
export function highlightStreet(streetName) {
    if (!state.streetData) return;
    
    const streetFeatures = state.streetData.features.filter(f => f.properties.name === streetName);
    if (streetFeatures.length === 0) return;
    
    state.map.getSource('street-highlight-source').setData({
        type: 'FeatureCollection',
        features: streetFeatures
    });
}

export function clearHighlight() {
    if (state.map.getSource('street-highlight-source')) {
        state.map.getSource('street-highlight-source').setData({
            type: 'FeatureCollection',
            features: []
        });
    }
}

// --- STREET NAME TOOLTIP ---
export function showStreetTooltip(e, streetName) {
    if (!document.getElementById('show-street-names-toggle').checked) return;
    
    const tooltip = document.getElementById('street-tooltip');
    tooltip.textContent = streetName;
    tooltip.style.display = 'block';
    tooltip.style.left = e.point.x + 'px';
    tooltip.style.top = e.point.y + 'px';
}

export function hideStreetTooltip() {
    const tooltip = document.getElementById('street-tooltip');
    tooltip.style.display = 'none';
}

export function setupStreetHoverEvents() {
    if (!state.map.getLayer('streets-found') || !state.map.getLayer('streets-unfound')) return;

    state.map.on('mouseenter', 'streets-found', (e) => {
        if (e.features.length > 0) {
            state.map.getCanvas().style.cursor = 'pointer';
            showStreetTooltip(e, e.features[0].properties.name);
        }
    });

    state.map.on('mouseleave', 'streets-found', () => {
        state.map.getCanvas().style.cursor = '';
        hideStreetTooltip();
    });

    state.map.on('mouseenter', 'streets-unfound', (e) => {
        if (e.features.length > 0 && document.getElementById('show-unfound-toggle').checked) {
            state.map.getCanvas().style.cursor = 'pointer';
            showStreetTooltip(e, e.features[0].properties.name);
        }
    });

    state.map.on('mouseleave', 'streets-unfound', () => {
        state.map.getCanvas().style.cursor = '';
        hideStreetTooltip();
    });
}

export function updateFoundStreetsLayer() {
    const foundStreetNames = Array.from(state.foundStreets).map(key => state.streetData.features.find(f => f.properties.name.toLowerCase() === key)?.properties.name).filter(Boolean);
    state.map.setFilter('streets-found', ['in', ['get', 'name'], ['literal', foundStreetNames]]);
    state.map.setPaintProperty('streets-found', 'line-opacity', 1);
}
