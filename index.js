import { state } from './src/state.js';
import { initMap, hideStreetTooltip } from './src/map/mapbox.js';
import { 
    switchGameMode, 
    handleMapClick, 
    submitGuess, 
    handleStreetInput, 
    confirmAndLoadCity, 
    toggleCityConfigMode, 
    resetGame,
    handleCitySearch,
    filterFoundItems,
    autofillNumberedStreets,
    undo,
    redo,
    nextIntersection
} from './src/game/core.js';
import { setLoadingState } from './src/game/ui.js';

// --- EVENT LISTENERS ---
document.addEventListener('DOMContentLoaded', function() {
    if (typeof mapboxgl === 'undefined') {
        const loadingText = document.getElementById('loading-text');
        if (loadingText) loadingText.textContent = 'Error: Mapbox GL JS failed to load.';
        return;
    }
    
    // Hide loading screen immediately since we're not auto-loading data
    setLoadingState(false);
    
    initMap();
    
    // Pass map click handler to mapbox map instance (which is in state)
    // We need to wait for map to be initialized in state, but initMap does it synchronously 
    // (though map load is async). We can attach listener to the map object in state.
    if (state.map) {
         state.map.on('click', handleMapClick);
    }

    // Mode selector
    const gameModeSelect = document.getElementById('game-mode-select');
    if (gameModeSelect) {
        gameModeSelect.addEventListener('change', (e) => {
            switchGameMode(e.target.value);
        });
    }
    
    // Difficulty selector
    const difficultySelect = document.getElementById('difficulty-select');
    if (difficultySelect) {
        difficultySelect.addEventListener('change', (e) => {
            state.intersectionDifficulty = e.target.value;
            if (state.streetData && state.gameMode === 'intersections') {
                // Just reset the current intersection, no need to regenerate all
                nextIntersection();
            }
        });
    }

    // Intersection mode submit button
    const submitGuessBtn = document.getElementById('submit-guess-btn');
    if (submitGuessBtn) {
        submitGuessBtn.addEventListener('click', submitGuess);
    }

    const streetInput = document.getElementById('street-input');
    if (streetInput) {
        streetInput.addEventListener('keypress', e => { if (e.key === 'Enter') handleStreetInput(); });
    }
    
    const loadAreaBtn = document.getElementById('load-area-btn');
    if (loadAreaBtn) {
        loadAreaBtn.addEventListener('click', () => confirmAndLoadCity());
    }
    
    const setCenterBtn = document.getElementById('set-center-btn');
    if (setCenterBtn) {
        setCenterBtn.addEventListener('click', () => {
            toggleCityConfigMode();
        });
    }
    
    const showUnfoundToggle = document.getElementById('show-unfound-toggle');
    if (showUnfoundToggle) {
        showUnfoundToggle.addEventListener('change', (e) => {
            if(state.map && state.map.getLayer('streets-unfound')) {
                state.map.setPaintProperty('streets-unfound', 'line-opacity', e.target.checked ? 0.2 : 0);
            }
        });
    }
    
    const showStreetNamesToggle = document.getElementById('show-street-names-toggle');
    if (showStreetNamesToggle) {
        showStreetNamesToggle.addEventListener('change', (e) => {
            if (!e.target.checked) {
                hideStreetTooltip();
            }
        });
    }
    
    const autofillBtn = document.getElementById('autofill-btn');
    if (autofillBtn) {
        autofillBtn.addEventListener('click', autofillNumberedStreets);
    }
    
    const cityInput = document.getElementById('city-input');
    if (cityInput) {
        cityInput.addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const query = e.target.value.trim();
                if (query) {
                    await handleCitySearch(query);
                }
            }
        });
    }
    
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => resetGame());
    }

    document.addEventListener('click', (e) => {
        const cityInputGroup = document.getElementById('city-input-group');
        const citySuggestions = document.getElementById('city-suggestions');
        if (cityInputGroup && citySuggestions && !cityInputGroup.contains(e.target)) {
            citySuggestions.style.display = 'none';
        }
    });
    
    const itemSearch = document.getElementById('item-search');
    if (itemSearch) {
        itemSearch.addEventListener('input', (e) => {
            filterFoundItems(e.target.value);
        });
    }
    
    // Keyboard shortcuts - Enter key for intersection mode and undo/redo
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && state.gameMode === 'intersections' && state.hasPlacedGuess) {
            submitGuess();
            return;
        }
        
        // Keyboard shortcuts for undo/redo
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? e.metaKey : e.ctrlKey;
        
        if (ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        } else if (ctrlKey && e.key.toLowerCase() === 'z' && e.shiftKey) {
            e.preventDefault();
            redo();
        }
    });
    
    // Initialize mode UI is handled by default state, but we can call switchGameMode to ensure sync
    // switchGameMode('streets'); 
    // Actually, default is streets in state.js. 
    // We might want to sync UI with state on load.
    // The original code didn't call updateModeUI explicitly on load, but relied on HTML defaulting to streets mode visibility.
    // We should probably call it to be safe.
    switchGameMode(state.gameMode);
});