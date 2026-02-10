import { state } from '../state.js';
import { 
    updateModeUI, 
    updateStats, 
    showMessage, 
    setLoadingState, 
    updateDifficultyVisibility,
    showAccuracyFeedback
} from './ui.js';
import { 
    generateRandomIntersection, 
    getStreetTypeCategory 
} from './intersections.js';
import { 
    setupCityMapLayers, 
    setupCityPreview, 
    highlightStreet, 
    clearHighlight, 
    updateFoundStreetsLayer,
    hideStreetTooltip 
} from '../map/mapbox.js';
import { 
    fetchStreetsFromOSM, 
    getCityBoundaries, 
    searchCities, 
    createFallbackBoundary 
} from '../api/osm.js';
import { 
    calculateBoundariesCenter, 
    getLargestPolygon, 
    calculateDistanceMeters 
} from '../utils/geo.js';
import { normalizeStreetName } from '../utils/string.js';

// --- GAME LOGIC ---

export function switchGameMode(newMode) {
    state.gameMode = newMode;
    updateModeUI();
    
    if (state.streetData) {
        if (state.gameMode === 'intersections') {
            nextIntersection();
        }
        updateStats();
        resetGame(false);
    }
}

export function nextIntersection() {
    state.currentIntersection = generateRandomIntersection();
    state.hasPlacedGuess = false;
    
    // Remove previous guess marker
    if (state.userGuessMarker) {
        state.userGuessMarker.remove();
        state.userGuessMarker = null;
    }
    
    // Update UI with null checks
    const submitBtn = document.getElementById('submit-guess-btn');
    const instructions = document.querySelector('.intersection-instructions');
    const targetIntersection = document.getElementById('target-intersection');
    
    if (state.currentIntersection) {
        if (targetIntersection) {
            let displayText = `${state.currentIntersection.street1} & ${state.currentIntersection.street2}`;
            if (state.currentIntersection.multipleLocations) {
                displayText += ` (${state.currentIntersection.locationCount} locations)`;
            }
            targetIntersection.textContent = displayText;
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            const instructionText = state.currentIntersection.multipleLocations 
                ? 'Click near any intersection of these streets'
                : 'Click on the map to place your guess';
            instructions.textContent = instructionText;
        }
    } else {
        if (targetIntersection) {
            // Check if we have no street data at all vs just no more intersections
            if (!state.streetData || state.streetData.features.length === 0) {
                targetIntersection.textContent = 'Click "Configure" to load a city first';
            } else {
                targetIntersection.textContent = 'No more intersections available!';
            }
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            if (!state.streetData || state.streetData.features.length === 0) {
                instructions.textContent = 'Load an area to start finding intersections';
            } else {
                instructions.textContent = 'Try changing difficulty or loading a different area';
            }
        }
    }
}

export function handleMapClick(e) {
    if (state.gameMode !== 'intersections' || !state.currentIntersection) return;
    
    const clickLat = e.lngLat.lat;
    const clickLng = e.lngLat.lng;
    
    // Remove previous guess marker if exists
    if (state.userGuessMarker) {
        state.userGuessMarker.remove();
    }
    
    // Place new guess marker
    state.userGuessMarker = new mapboxgl.Marker({ color: '#ff6464' })
        .setLngLat([clickLng, clickLat])
        .addTo(state.map);
    
    state.hasPlacedGuess = true;
    
    // Show submit button and update instructions with null checks
    const submitBtn = document.getElementById('submit-guess-btn');
    const instructions = document.querySelector('.intersection-instructions');
    
    if (submitBtn) submitBtn.style.display = 'inline-block';
    if (instructions) instructions.textContent = 'Click Submit Guess or press Enter to confirm';
}

export function submitGuess() {
    if (!state.currentIntersection || !state.hasPlacedGuess || !state.userGuessMarker) return;
    
    const guessLngLat = state.userGuessMarker.getLngLat();
    const clickLat = guessLngLat.lat;
    const clickLng = guessLngLat.lng;
    
    // Find the closest valid intersection location
    let closestDistance = Infinity;
    let bestLocation = state.validIntersectionLocations[0];
    
    state.validIntersectionLocations.forEach(location => {
        const distance = calculateDistanceMeters(clickLat, clickLng, location.lat, location.lng);
        if (distance < closestDistance) {
            closestDistance = distance;
            bestLocation = location;
        }
    });
    
    const accuracy = Math.max(0, 1000 - closestDistance); // Max 1000 points for perfect accuracy
    const points = Math.floor(accuracy);
    
    // Show actual intersection location(s)
    const actualMarkers = [];
    state.validIntersectionLocations.forEach((location, index) => {
        const color = index === state.validIntersectionLocations.indexOf(bestLocation) ? '#00c8ff' : '#00ff88';
        const marker = new mapboxgl.Marker({ color: color })
            .setLngLat([location.lng, location.lat])
            .addTo(state.map);
        actualMarkers.push(marker);
    });
    
    // Draw line between guess and closest actual location
    const lineData = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [[clickLng, clickLat], [bestLocation.lng, bestLocation.lat]]
            }
        }]
    };
    
    // Add line to map
    if (state.map.getSource('guess-line')) {
        state.map.removeLayer('guess-line');
        state.map.removeSource('guess-line');
    }
    
    state.map.addSource('guess-line', {
        type: 'geojson',
        data: lineData
    });
    
    state.map.addLayer({
        id: 'guess-line',
        type: 'line',
        source: 'guess-line',
        paint: {
            'line-color': '#ffff00',
            'line-width': 3,
            'line-dasharray': [2, 2]
        }
    });
    
    // Mark intersection as found (for tracking, but no list display)
    const key = `${state.currentIntersection.street1}|${state.currentIntersection.street2}`;
    state.foundIntersections.add(key);
    state.intersectionScore += points;
    state.intersectionAccuracy.push(closestDistance);
    
    // Show accuracy feedback
    showAccuracyFeedback(closestDistance, points);
    
    // Update stats
    updateStats();
    
    // Clean up after delay and get next intersection
    setTimeout(() => {
        // Remove markers and line
        if (state.userGuessMarker) {
            state.userGuessMarker.remove();
            state.userGuessMarker = null;
        }
        
        actualMarkers.forEach(m => m.remove());
        
        if (state.map.getSource('guess-line')) {
            state.map.removeLayer('guess-line');
            state.map.removeSource('guess-line');
        }
        
        nextIntersection();
    }, 2500);
}

export function resetGame(fullReload = true) {
    if (!state.streetData) return;
    state.foundStreets.clear();
    state.foundIntersections.clear();
    state.intersectionScore = 0;
    state.intersectionAccuracy = [];
    state.hasPlacedGuess = false;
    state.validIntersectionLocations = [];
    
    // Clean up intersection mode elements
    if (state.userGuessMarker) {
        state.userGuessMarker.remove();
        state.userGuessMarker = null;
    }
    
    if (state.map.getSource('guess-line')) {
        state.map.removeLayer('guess-line');
        state.map.removeSource('guess-line');
    }
    
    // Only clear the found items list if we're in streets mode
    if (state.gameMode === 'streets') {
        const foundItemsList = document.getElementById('found-items-list');
        const itemSearch = document.getElementById('item-search');
        
        if (foundItemsList) foundItemsList.innerHTML = '';
        if (itemSearch) itemSearch.value = '';
    }
    
    state.undoHistory = [];
    state.redoHistory = [];
    updateUndoRedoButtons();
    
    if (state.map.getLayer('streets-found')) {
        state.map.setFilter('streets-found', ['in', ['get', 'name'], ['literal', []]]);
    }
    
    clearHighlight();
    
    if (state.gameMode === 'intersections') {
        nextIntersection();
    }
    
    updateStats();
    if (fullReload) {
        if (state.cityBoundaries) {
            const center = calculateBoundariesCenter(state.cityBoundaries);
            loadStreetsForCity(state.cityBoundaries, center[1], center[0]);
        }
    } else {
        if (state.currentCenter) {
            state.map.flyTo({ center: state.currentCenter, zoom: 10, duration: 1000 });
        }
    }
    const messageElement = document.getElementById('message');
    if (messageElement) messageElement.classList.remove('show');
}

export function confirmAndLoadCity() {
    if (!state.previewCity) return;
    
    state.cityBoundaries = state.previewCity.boundaries;
    const center = calculateBoundariesCenter(state.cityBoundaries);
    
    // Hide preview UI
    const previewInfo = document.getElementById('preview-info');
    const loadAreaGroup = document.getElementById('load-area-group');
    if (previewInfo) previewInfo.style.display = 'none';
    if (loadAreaGroup) loadAreaGroup.style.display = 'none';
    
    // Prevent reversion to previous config
    state.isPreviewMode = false;
    state.previousGameConfig = null;
    state.previewCity = null;

    // Reset toggle button
    toggleCityConfigMode(false);
    
    // Load streets
    loadStreetsForCity(state.cityBoundaries, center[1], center[0]);
}

export async function loadStreetsForCity(boundaries, lat, lng) {
    state.currentCenter = [lng, lat];
    
    const mainBoundary = getLargestPolygon(boundaries);
    const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
    let areaDescription = 'selected area';
    
    if (coords.length > 0) {
        const lats = coords.map(c => c[1]);
        const lngs = coords.map(c => c[0]);
        const latSpan = Math.max(...lats) - Math.min(...lats);
        const lonSpan = Math.max(...lngs) - Math.min(...lngs);
        const roughKm = Math.max(latSpan, lonSpan) * 111;
        
        if (roughKm < 5) {
            areaDescription = 'neighbourhood';
        } else if (roughKm < 15) {
            areaDescription = 'district';
        } else if (roughKm < 40) {
            areaDescription = 'city area';
        } else {
            areaDescription = 'large area';
        }
    }
    
    setLoadingState(true, `Fetching streets for ${areaDescription}...`);
    
    try {
        state.streetData = await fetchStreetsFromOSM(boundaries);
        state.totalLength = state.streetData.features.reduce((sum, f) => sum + f.properties.length, 0);

        setupCityMapLayers(boundaries, lat, lng);
        
        // Start with first intersection if in intersection mode
        if (state.gameMode === 'intersections') {
            nextIntersection();
        }
        
        resetGame(false);
        updateStats();
        
        const streetInput = document.getElementById('street-input');
        const resetBtn = document.getElementById('reset-btn');
        if (streetInput) {
            streetInput.disabled = false;
            streetInput.placeholder = 'ENTER A STREET';
        }
        if (resetBtn) resetBtn.disabled = false;
        
    } catch (error) {
        console.error('Error loading streets:', error);
        showMessage('Error loading street data. Please try again.', 'error');
    } finally {
        setTimeout(() => setLoadingState(false), 500);
    }
}

export function toggleCityConfigMode(forceState = null) {
    state.isSettingCenter = forceState ?? !state.isSettingCenter;
    const btn = document.getElementById('set-center-btn');
    
    if (!state.isSettingCenter) {
        if (state.isPreviewMode && state.previousGameConfig) {
            state.cityBoundaries = state.previousGameConfig.boundaries;
            state.GAME_CENTER = [...state.previousGameConfig.center];
            
            if (state.streetData && state.cityBoundaries) {
                const center = calculateBoundariesCenter(state.cityBoundaries);
                setupCityMapLayers(state.cityBoundaries, center[1], center[0]);
            }
        }
        
        state.isPreviewMode = false;
        state.previewCity = null;
        state.previousGameConfig = null;
        btn.textContent = 'Configure';
        btn.classList.remove('active', 'preview');
        
        const previewInfo = document.getElementById('preview-info');
        const cityInputGroup = document.getElementById('city-input-group');
        const loadAreaGroup = document.getElementById('load-area-group');
        const cityInput = document.getElementById('city-input');
        const citySuggestions = document.getElementById('city-suggestions');
        
        if (previewInfo) previewInfo.style.display = 'none';
        if (cityInputGroup) {
            cityInputGroup.style.display = 'none';
        }
        if (loadAreaGroup) loadAreaGroup.style.display = 'none';
        
        if (cityInput) cityInput.value = '';
        if (citySuggestions) citySuggestions.style.display = 'none';
        
        if (!state.streetData) {
            ['city-boundary-fill', 'city-boundary-line'].forEach(id => {
                if (state.map.getLayer(id)) state.map.removeLayer(id);
            });
            if (state.map.getSource('city-boundary')) state.map.removeSource('city-boundary');
        }
    } else {
        btn.textContent = 'Cancel';
        btn.classList.add('active');
        
        const cityInputGroup = document.getElementById('city-input-group');
        
        if (cityInputGroup) {
            cityInputGroup.style.display = 'block';
            
            setTimeout(() => {
                const cityInput = document.getElementById('city-input');
                if (cityInput) {
                    cityInput.focus();
                }
            }, 100);
        } else {
            console.error('cityInputGroup element not found!');
        }
    }
    
    // Update difficulty dropdown visibility when configure mode changes
    updateDifficultyVisibility();
}

export function handleStreetInput() {
    if (!state.streetData) return;
    
    const inputField = document.getElementById('street-input');
    const inputValue = inputField.value.trim();
    
    if (!inputValue) return;
    
    // Split by comma to support multiple entries
    const values = inputValue.split(',').map(v => v.trim()).filter(v => v.length > 0);
    let anyFound = false;
    
    values.forEach(value => {
        if (checkStreet(value)) {
            anyFound = true;
        }
    });
    
    inputField.value = '';
}

function checkStreet(value) {
    if (!state.streetData || !value) return false;
    
    const matchedStreets = findAllMatchingStreets(value);
    let newStreetsFound = false;
    let streetsToAdd = [];
    
    if (matchedStreets.length > 0) {
        for (const street of matchedStreets) {
            const streetKey = street.properties.name.toLowerCase();
            if (!state.foundStreets.has(streetKey)) {
                streetsToAdd.push(street.properties.name);
                newStreetsFound = true;
            }
        }
        
        if (newStreetsFound) {
            saveState();
            
            streetsToAdd.forEach(streetName => {
                state.foundStreets.add(streetName.toLowerCase());
                addStreetToList(streetName, false);
            });
            
            updateFoundStreetsLayer();
            updateStats();
            showMessage(`Found ${matchedStreets.length} street(s) for "${value}"!`, 'success');
        } else {
            showMessage(`You already found all streets for "${value}"!`, 'error');
        }
    } else {
        showMessage('Street not found. Try a different name or spelling.', 'error');
    }
    
    return newStreetsFound;
}

export function findAllMatchingStreets(inputName) {
    if (!state.streetData || !inputName) return [];
    
    const inputLower = inputName.toLowerCase();
    const exactMatches = state.streetData.features.filter(f => f.properties.name.toLowerCase() === inputLower);
    
    if (exactMatches.length > 0) {
        return exactMatches;
    }
    
    const inputNormalized = normalizeStreetName(inputName);
    return state.streetData.features.filter(f => normalizeStreetName(f.properties.name) === inputNormalized);
}

export function addStreetToList(streetName, saveToHistory = true) {
    const list = document.getElementById('found-items-list');
    if (!list) return;
    
    const item = document.createElement('div');
    item.className = 'found-item';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = streetName;
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-item-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete street';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteStreet(streetName);
    });
    
    item.appendChild(nameSpan);
    item.appendChild(deleteBtn);
    
    item.addEventListener('mousedown', (e) => {
        if (e.target === deleteBtn) return;
        item.classList.add('holding');
        highlightStreet(streetName);
        
        state.holdTimeout = setTimeout(() => {
            // Extended hold behavior could go here
        }, 1000);
    });
    
    item.addEventListener('mouseup', () => {
        item.classList.remove('holding');
        clearHighlight();
        if (state.holdTimeout) {
            clearTimeout(state.holdTimeout);
            state.holdTimeout = null;
        }
    });
    
    item.addEventListener('mouseleave', () => {
        item.classList.remove('holding');
        clearHighlight();
        if (state.holdTimeout) {
            clearTimeout(state.holdTimeout);
            state.holdTimeout = null;
        }
    });
    
    nameSpan.addEventListener('dblclick', () => {
        // Find bounds for the street and fit map
        const streetFeatures = state.streetData.features.filter(f => f.properties.name === streetName);
        if (streetFeatures.length > 0) {
             const bounds = new mapboxgl.LngLatBounds();
             streetFeatures.forEach(feature => {
                 if (feature.geometry.type === 'LineString') {
                     feature.geometry.coordinates.forEach(c => bounds.extend(c));
                 } else if (feature.geometry.type === 'MultiLineString') {
                     feature.geometry.coordinates.forEach(bg => bg.forEach(c => bounds.extend(c)));
                 }
             });
             state.map.fitBounds(bounds, {
                padding: 50,
                maxZoom: 16,
                duration: 1000
            });
        }
    });
    
    list.prepend(item);
}

export function deleteStreet(streetName) {
    const streetKey = streetName.toLowerCase();
    if (state.foundStreets.has(streetKey)) {
        saveState();
        state.foundStreets.delete(streetKey);
        
        const items = document.querySelectorAll('.found-item');
        items.forEach(item => {
            if (item.querySelector('.item-name').textContent === streetName) {
                item.remove();
            }
        });
        
        updateFoundStreetsLayer();
        updateStats();
        showMessage(`Removed "${streetName}"`, 'success');
    }
}

// --- UNDO/REDO ---
export function saveState() {
    const historyState = {
        foundStreets: new Set(state.foundStreets),
        foundIntersections: new Set(state.foundIntersections),
        timestamp: Date.now()
    };
    
    state.undoHistory.push(historyState);
    if (state.undoHistory.length > state.maxHistorySize) {
        state.undoHistory.shift();
    }
    
    state.redoHistory = [];
    updateUndoRedoButtons();
}

export function undo() {
    if (state.undoHistory.length === 0) return;
    
    const currentState = {
        foundStreets: new Set(state.foundStreets),
        foundIntersections: new Set(state.foundIntersections),
        timestamp: Date.now()
    };
    state.redoHistory.push(currentState);
    
    const prevState = state.undoHistory.pop();
    state.foundStreets = new Set(prevState.foundStreets);
    state.foundIntersections = new Set(prevState.foundIntersections);
    
    rebuildFoundItemsList();
    if (state.gameMode === 'streets') {
        updateFoundStreetsLayer();
    }
    updateStats();
    updateUndoRedoButtons();
}

export function redo() {
    if (state.redoHistory.length === 0) return;
    
    const currentState = {
        foundStreets: new Set(state.foundStreets),
        foundIntersections: new Set(state.foundIntersections),
        timestamp: Date.now()
    };
    state.undoHistory.push(currentState);
    
    const nextState = state.redoHistory.pop();
    state.foundStreets = new Set(nextState.foundStreets);
    state.foundIntersections = new Set(nextState.foundIntersections);
    
    rebuildFoundItemsList();
    if (state.gameMode === 'streets') {
        updateFoundStreetsLayer();
    }
    updateStats();
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    // No physical buttons to update anymore, but keeping function for logic completeness
}

function rebuildFoundItemsList() {
    const list = document.getElementById('found-items-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    if (state.gameMode === 'streets') {
        const foundStreetNames = Array.from(state.foundStreets).map(key => 
            state.streetData.features.find(f => f.properties.name.toLowerCase() === key)?.properties.name
        ).filter(Boolean);
        
        foundStreetNames.forEach(streetName => {
            addStreetToList(streetName, false);
        });
    }
}

// --- AUTOFILL ---
export function autofillNumberedStreets() {
    const from = parseInt(document.getElementById('autofill-from').value);
    const to = parseInt(document.getElementById('autofill-to').value);
    if (isNaN(from) || isNaN(to) || from > to) {
        showMessage('Invalid number range for autofill.', 'error');
        return;
    }
    
    let foundAny = false;
    let streetsToAdd = [];
    
    for (let i = from; i <= to; i++) {
        const streetName = i + getOrdinalSuffix(i);
        const matchedStreets = findAllMatchingStreets(streetName);
        for (const street of matchedStreets) {
            const streetKey = street.properties.name.toLowerCase();
            if (!state.foundStreets.has(streetKey)) {
                streetsToAdd.push(street.properties.name);
                foundAny = true;
            }
        }
    }
    
    if (foundAny) {
        saveState();
        
        streetsToAdd.forEach(streetName => {
            state.foundStreets.add(streetName.toLowerCase());
            addStreetToList(streetName, false);
        });
        
        updateFoundStreetsLayer();
        updateStats();
        showMessage(`Found ${streetsToAdd.length} numbered streets in range ${from}-${to}.`, 'success');
    } else {
        showMessage(`No new numbered streets found in range ${from}-${to}.`, 'error');
    }
}

function getOrdinalSuffix(i) {
    const j = i % 10, k = i % 100;
    if (j == 1 && k != 11) return "st";
    if (j == 2 && k != 12) return "nd";
    if (j == 3 && k != 13) return "rd";
    return "th";
}

// --- CITY SEARCH ---
export async function handleCitySearch(query) {
    const suggestionsDiv = document.getElementById('city-suggestions');
    if (!suggestionsDiv) return;
    
    if (!query || query.length < 2) {
        suggestionsDiv.style.display = 'none';
        return;
    }
    
    suggestionsDiv.innerHTML = '<div class="city-suggestion">Searching...</div>';
    suggestionsDiv.style.display = 'block';
    
    try {
        const cities = await searchCities(query);
        showCitySuggestions(cities);
    } catch (error) {
        console.error('Error searching cities:', error);
        suggestionsDiv.innerHTML = '<div class="city-suggestion">Error searching. Try again.</div>';
    }
}

function showCitySuggestions(cities) {
    const suggestionsDiv = document.getElementById('city-suggestions');
    if (!suggestionsDiv) return;
    
    if (cities.length === 0) {
        suggestionsDiv.innerHTML = '<div class="city-suggestion">No results found. Try a different search term.</div>';
        return;
    }
    
    suggestionsDiv.innerHTML = '';
    
    cities.forEach(city => {
        const suggestion = document.createElement('div');
        suggestion.className = 'city-suggestion';
        
        const placeTypeDisplay = city.placeType ? 
            city.placeType.charAt(0).toUpperCase() + city.placeType.slice(1) : 'Place';
        
        suggestion.innerHTML = `
            <div class="city-suggestion-name">${city.name}</div>
            <div class="city-suggestion-details">${placeTypeDisplay} • ${city.fullName}</div>
        `;
        
        suggestion.addEventListener('click', async () => {
            const cityInput = document.getElementById('city-input');
            if (cityInput) cityInput.value = city.name;
            suggestionsDiv.style.display = 'none';
            
            // Should be in selectCity but here for context
             try {
                setLoadingState(true, `Fetching boundaries for ${city.name}...`);
                const boundaries = await getCityBoundaries(city.osmType, city.osmId, city);
                
                if (boundaries) {
                    setupCityPreview(boundaries);
                     
                     // Enable preview mode styles
                    if (!state.isPreviewMode) {
                        state.previousGameConfig = {
                            boundaries: state.cityBoundaries,
                            center: [...state.GAME_CENTER]
                        };
                        
                        state.isPreviewMode = true;
                        const btn = document.getElementById('set-center-btn');
                        btn.textContent = 'Cancel';
                        btn.classList.add('preview');
                        
                        const previewInfo = document.getElementById('preview-info');
                        if (previewInfo) {
                            previewInfo.style.display = 'block';
                            // Logic to update text content
                             const locationType = city.placeType ? 
                                city.placeType.charAt(0).toUpperCase() + city.placeType.slice(1) : 'Area';
                            const mainBoundary = getLargestPolygon(boundaries);
                            const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
                            // simplified boundary info check
                            const boundaryInfo = 'official'; 
                            
                            previewInfo.textContent = `${locationType} boundary (${boundaryInfo}) preview shown. Click "Load New Area" to start the game.`;
                        }
                        
                        document.getElementById('load-area-group').style.display = 'block';
                        
                        state.previewCity = {
                            ...city,
                            boundaries: getLargestPolygon(boundaries)
                        };
                    } else {
                         state.previewCity = {
                            ...city,
                            boundaries: getLargestPolygon(boundaries) // Update preview city
                        };
                    }

                } else {
                    showMessage('Could not create boundaries for this location. Try a different place.', 'error');
                }
            } catch (error) {
                console.error('Error fetching city boundaries:', error);
                showMessage('Error fetching location data. Try again.', 'error');
            } finally {
                setLoadingState(false);
            }
        });
        
        suggestionsDiv.appendChild(suggestion);
    });
    
    suggestionsDiv.style.display = 'block';
}

export function filterFoundItems(searchTerm) {
    const items = document.querySelectorAll('.found-item');
    const term = searchTerm.toLowerCase();
    
    items.forEach(item => {
        const itemNameElement = item.querySelector('.item-name');
        const itemName = itemNameElement ? itemNameElement.textContent.toLowerCase() : '';
        if (itemName.includes(term)) {
            item.classList.remove('hidden');
        } else {
            item.classList.add('hidden');
        }
    });
}
