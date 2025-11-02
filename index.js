// CONFIGURATION
let GAME_CENTER = [-122.3321, 47.6062]; // Seattle [lng, lat]
let isSettingCenter = false;
let isPreviewMode = false;
let previewCity = null;
let previousGameConfig = null;
let cityBoundaries = null;

// GAME MODE MANAGEMENT
let gameMode = 'streets'; // 'streets' or 'intersections'
let intersectionDifficulty = 'major-major'; // 'major-major', 'major-all', 'all-all'

// UNDO/REDO SYSTEM
let undoHistory = [];
let redoHistory = [];
let maxHistorySize = 50;

// MAPBOX
mapboxgl.accessToken = process.env.MAPBOX_ACCESS_TOKEN;
let map;
let streetData = null;
let streetSegmentsData = null; // NEW: Store detailed segment data for location-specific classification
let foundStreets = new Set();
let foundIntersections = new Set();
let totalLength = 0;
let currentCenter;
let highlightedStreet = null;
let holdTimeout = null;
let streetTooltip = null;

// INTERSECTION MODE VARIABLES
let currentIntersection = null;
let intersectionScore = 0;
let intersectionAccuracy = [];
let userGuessMarker = null;
let hasPlacedGuess = false;
let validIntersectionLocations = []; // Store all valid locations for current intersection

// --- UTILITY FUNCTIONS ---
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; 
    const dLat = (lat2 - lat1) * Math.PI / 180; 
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c;
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    return calculateDistance(lat1, lon1, lat2, lon2) * 1609.34; // Convert miles to meters
}

function calculatePolygonArea(coordinates) {
    if (!coordinates || coordinates.length === 0) return 0;
    
    let area = 0;
    const ring = coordinates[0];
    
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        area += (x1 * y2 - x2 * y1);
    }
    
    return Math.abs(area / 2);
}

function getLargestPolygon(boundaries) {
    if (!boundaries) return null;
    
    if (boundaries.type === 'Polygon') {
        return boundaries;
    }
    
    if (boundaries.type === 'MultiPolygon') {
        let largestPolygon = null;
        let largestArea = 0;
        
        boundaries.coordinates.forEach(polygonCoords => {
            const area = calculatePolygonArea(polygonCoords);
            if (area > largestArea) {
                largestArea = area;
                largestPolygon = {
                    type: 'Polygon',
                    coordinates: polygonCoords
                };
            }
        });
        
        console.log(`MultiPolygon with ${boundaries.coordinates.length} parts - selected largest with area ${largestArea.toFixed(6)}`);
        return largestPolygon;
    }
    
    return boundaries;
}

// --- NEW: LOCATION-SPECIFIC ROAD CLASSIFICATION ---
function getStreetTypeAtLocation(streetName, lat, lng) {
    if (!streetSegmentsData || !streetSegmentsData.has(streetName)) {
        return 'residential'; // Default fallback
    }
    
    const segments = streetSegmentsData.get(streetName);
    let closestSegment = null;
    let closestDistance = Infinity;
    
    // Find the closest segment to the given location
    segments.forEach(segment => {
        const segmentDistance = getDistanceToLineString(lat, lng, segment.coordinates);
        if (segmentDistance < closestDistance) {
            closestDistance = segmentDistance;
            closestSegment = segment;
        }
    });
    
    return closestSegment ? closestSegment.type : 'residential';
}

function getDistanceToLineString(lat, lng, coordinates) {
    let minDistance = Infinity;
    
    for (let i = 0; i < coordinates.length - 1; i++) {
        const segmentStart = coordinates[i];
        const segmentEnd = coordinates[i + 1];
        const distance = getDistanceToLineSegment(lat, lng, segmentStart, segmentEnd);
        minDistance = Math.min(minDistance, distance);
    }
    
    return minDistance;
}

function getDistanceToLineSegment(lat, lng, segmentStart, segmentEnd) {
    const [x1, y1] = segmentStart;
    const [x2, y2] = segmentEnd;
    const [px, py] = [lng, lat];
    
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    
    let param = -1;
    if (lenSq !== 0) {
        param = dot / lenSq;
    }
    
    let xx, yy;
    if (param < 0) {
        xx = x1;
        yy = y1;
    } else if (param > 1) {
        xx = x2;
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }
    
    return calculateDistanceMeters(lat, lng, yy, xx);
}

// --- MODE MANAGEMENT ---
function switchGameMode(newMode) {
    gameMode = newMode;
    updateModeUI();
    
    if (streetData) {
        if (gameMode === 'intersections') {
            nextIntersection();
        }
        updateStats();
        resetGame(false);
    }
}

function updateModeUI() {
    const streetInputContainer = document.getElementById('street-input-container');
    const intersectionDisplayContainer = document.getElementById('intersection-display-container');
    const autofillSection = document.getElementById('autofill-section');
    const difficultyGroup = document.getElementById('difficulty-group');
    const foundItemsSection = document.getElementById('found-items-section');
    const foundListTitle = document.getElementById('found-list-title');
    const itemSearch = document.getElementById('item-search');
    const scoreLabel = document.getElementById('score-label');
    
    // Stats elements with null checks
    const foundStat = document.getElementById('found-stat');
    const percentageStat = document.getElementById('percentage-stat');
    const totalStat = document.getElementById('total-stat');
    const distanceStat = document.getElementById('distance-stat');
    
    if (gameMode === 'streets') {
        if (streetInputContainer) streetInputContainer.style.display = 'block';
        if (intersectionDisplayContainer) intersectionDisplayContainer.style.display = 'none';
        if (autofillSection) autofillSection.style.display = 'block';
        if (foundItemsSection) foundItemsSection.style.display = 'flex';
        if (foundListTitle) foundListTitle.textContent = 'Found Streets';
        if (itemSearch) itemSearch.placeholder = 'Search found streets...';
        if (scoreLabel) scoreLabel.textContent = 'of street distance';
        
        // Show all stats for street mode
        if (foundStat) foundStat.style.display = 'block';
        if (percentageStat) percentageStat.style.display = 'block';
        if (totalStat) totalStat.style.display = 'block';
        if (distanceStat) distanceStat.style.display = 'block';
        
    } else if (gameMode === 'intersections') {
        if (streetInputContainer) streetInputContainer.style.display = 'none';
        if (intersectionDisplayContainer) intersectionDisplayContainer.style.display = 'block';
        if (autofillSection) autofillSection.style.display = 'none';
        if (foundItemsSection) foundItemsSection.style.display = 'none';  // Hide found intersections list
        if (scoreLabel) scoreLabel.textContent = 'average accuracy';
        
        // Hide all stats for intersection mode - only show main score
        if (foundStat) foundStat.style.display = 'none';
        if (percentageStat) percentageStat.style.display = 'none';
        if (totalStat) totalStat.style.display = 'none';
        if (distanceStat) distanceStat.style.display = 'none';
        
        // Update intersection display with proper messaging
        if (currentIntersection) {
            const targetIntersection = document.getElementById('target-intersection');
            if (targetIntersection) {
                targetIntersection.textContent = `${currentIntersection.street1} & ${currentIntersection.street2}`;
            }
        } else {
            // Call nextIntersection to show proper messaging for no data case
            nextIntersection();
        }
    }
    
    // Update difficulty dropdown visibility: only show when in intersection mode AND configure mode is active
    updateDifficultyVisibility();
}

// New function to handle difficulty dropdown visibility
function updateDifficultyVisibility() {
    const difficultyGroup = document.getElementById('difficulty-group');
    if (difficultyGroup) {
        const shouldShow = gameMode === 'intersections' && isSettingCenter;
        difficultyGroup.style.display = shouldShow ? 'block' : 'none';
    }
}

// --- INTERSECTION GENERATION (Improved with Location-Specific Classification) ---
function getStreetTypeCategory(streetType) {
    const major = ['major', 'primary', 'secondary', 'tertiary'];
    return major.includes(streetType) ? 'major' : 'local';
}

function getHighestStreetType(streetName, lat = null, lng = null) {
    // If location is provided, get the type at that specific location
    if (lat !== null && lng !== null) {
        return getStreetTypeAtLocation(streetName, lat, lng);
    }
    
    // Fallback to overall street type
    const streetFeature = streetData.features.find(f => f.properties.name === streetName);
    return streetFeature ? streetFeature.properties.type : 'residential';
}

function findIntersectingStreets(targetStreet) {
    const maxDistance = 5; // Maximum 5 meters apart to be considered intersecting
    const intersectingStreets = [];
    
    // Get normalized name of target street to avoid same-street intersections
    const targetNormalized = normalizeStreetName(targetStreet.properties.name);
    
    // Only check a subset of streets to improve performance
    const maxStreetsToCheck = Math.min(streetData.features.length, 200);
    const streetsToCheck = streetData.features
        .filter(s => {
            // Filter out exact name matches
            if (s.properties.name === targetStreet.properties.name) return false;
            
            // Filter out streets that have the same normalized name (e.g., "E Broadway" vs "Broadway")
            const otherNormalized = normalizeStreetName(s.properties.name);
            return otherNormalized !== targetNormalized;
        })
        .sort(() => Math.random() - 0.5)
        .slice(0, maxStreetsToCheck);
    
    let checkedCount = 0;
    let foundCount = 0;
    
    streetsToCheck.forEach(otherStreet => {
        checkedCount++;
        
        // Check if already found this intersection pair (avoid duplicates)
        const key1 = `${targetStreet.properties.name}|${otherStreet.properties.name}`;
        const key2 = `${otherStreet.properties.name}|${targetStreet.properties.name}`;
        if (foundIntersections.has(key1) || foundIntersections.has(key2)) return;
        
        const intersections = findAllIntersectionsBetweenStreets(targetStreet.geometry, otherStreet.geometry);
        
        if (intersections.length > 0) {
            // Filter intersections by distance and validate road types at each location
            const validIntersections = intersections.filter(intersection => {
                if (intersection.distance > maxDistance) return false;
                
                // NEW: Check road types at the specific intersection location
                const type1AtLocation = getStreetTypeAtLocation(targetStreet.properties.name, intersection.lat, intersection.lng);
                const type2AtLocation = getStreetTypeAtLocation(otherStreet.properties.name, intersection.lat, intersection.lng);
                
                const category1 = getStreetTypeCategory(type1AtLocation);
                const category2 = getStreetTypeCategory(type2AtLocation);
                
                // Validate against difficulty criteria using location-specific types
                switch (intersectionDifficulty) {
                    case 'major-major':
                        return category1 === 'major' && category2 === 'major';
                    case 'major-all':
                        return category1 === 'major' || category2 === 'major';
                    case 'all-all':
                        return true;
                    default:
                        return false;
                }
            });
            
            if (validIntersections.length > 0) {
                intersectingStreets.push({
                    street: otherStreet,
                    intersections: validIntersections
                });
                foundCount++;
            }
        }
    });
    
    console.log(`  - Checked ${checkedCount} streets, found ${foundCount} valid intersections with location-specific classification`);
    return intersectingStreets;
}

// New function to find ALL intersections between two streets
function findAllIntersectionsBetweenStreets(geom1, geom2) {
    const maxDistance = 50; // Maximum 50 meters apart to be considered intersecting (broader for initial detection)
    const intersections = [];
    
    // Get all line segments from both geometries
    const lines1 = geom1.type === 'LineString' ? [geom1.coordinates] : geom1.coordinates;
    const lines2 = geom2.type === 'LineString' ? [geom2.coordinates] : geom2.coordinates;
    
    lines1.forEach(line1 => {
        lines2.forEach(line2 => {
            // Check every segment against every other segment
            for (let i = 0; i < line1.length - 1; i++) {
                for (let j = 0; j < line2.length - 1; j++) {
                    const seg1Start = line1[i];
                    const seg1End = line1[i + 1];
                    const seg2Start = line2[j];
                    const seg2End = line2[j + 1];
                    
                    const closestPoints = getClosestPointsBetweenSegments(
                        seg1Start, seg1End, seg2Start, seg2End
                    );
                    
                    const distance = calculateDistanceMeters(
                        closestPoints.point1[1], closestPoints.point1[0],
                        closestPoints.point2[1], closestPoints.point2[0]
                    );
                    
                    if (distance <= maxDistance) {
                        // Use midpoint between the two closest points
                        const intersection = {
                            lat: (closestPoints.point1[1] + closestPoints.point2[1]) / 2,
                            lng: (closestPoints.point1[0] + closestPoints.point2[0]) / 2,
                            distance: distance
                        };
                        
                        // Check if this intersection is too close to an existing one (avoid duplicates)
                        const isDuplicate = intersections.some(existing => 
                            calculateDistanceMeters(existing.lat, existing.lng, intersection.lat, intersection.lng) < 20
                        );
                        
                        if (!isDuplicate) {
                            intersections.push(intersection);
                        }
                    }
                }
            }
        });
    });
    
    return intersections;
}

function generateRandomIntersection() {
    if (!streetData || streetData.features.length === 0) {
        return null;
    }
    
    console.log(`Generating intersection using street-first approach (difficulty: ${intersectionDifficulty})...`);
    
    // Step 1: Filter streets by difficulty to pick the first street
    let primaryStreets = [];
    
    switch (intersectionDifficulty) {
        case 'major-major':
        case 'major-all':
            // Start with streets that have at least some major segments
            primaryStreets = streetData.features.filter(street => {
                // Check if this street has any major-type segments
                if (!streetSegmentsData.has(street.properties.name)) return false;
                const segments = streetSegmentsData.get(street.properties.name);
                return segments.some(segment => getStreetTypeCategory(segment.type) === 'major');
            });
            console.log(`Found ${primaryStreets.length} streets with major segments to start with`);
            break;
        case 'all-all':
            // Can start with any street
            primaryStreets = [...streetData.features];
            console.log(`Using all ${primaryStreets.length} streets as potential starting points`);
            break;
    }
    
    if (primaryStreets.length === 0) {
        console.log('No suitable primary streets found for difficulty:', intersectionDifficulty);
        return null;
    }
    
    // Step 2: Try multiple primary streets until we find a valid intersection
    const shuffledPrimary = [...primaryStreets].sort(() => Math.random() - 0.5);
    
    for (let i = 0; i < Math.min(50, shuffledPrimary.length); i++) {
        const primaryStreet = shuffledPrimary[i];
        console.log(`Trying primary street: ${primaryStreet.properties.name} (overall: ${primaryStreet.properties.type})`);
        
        const intersectingStreets = findIntersectingStreets(primaryStreet);
        
        if (intersectingStreets.length === 0) {
            console.log(`  - No valid intersecting streets found`);
            continue;
        }
        
        // Step 3: Pick a random valid intersection (filtering is done in findIntersectingStreets)
        const randomIntersection = intersectingStreets[Math.floor(Math.random() * intersectingStreets.length)];
        
        // Handle multiple intersection locations for the same street pair
        const intersectionLocations = randomIntersection.intersections;
        
        if (intersectionLocations.length > 1) {
            console.log(`✓ Found ${intersectionLocations.length} locations for intersection: ${primaryStreet.properties.name} & ${randomIntersection.street.properties.name}`);
            
            // Store all valid locations and pick the most central one as the primary
            validIntersectionLocations = intersectionLocations.map(loc => ({
                lat: loc.lat,
                lng: loc.lng,
                distance: loc.distance
            }));
            
            // Use the intersection with the smallest distance (most precise)
            const primaryLocation = intersectionLocations.reduce((best, current) => 
                current.distance < best.distance ? current : best
            );
            
            // Get road types at the actual intersection location
            const type1AtLocation = getStreetTypeAtLocation(primaryStreet.properties.name, primaryLocation.lat, primaryLocation.lng);
            const type2AtLocation = getStreetTypeAtLocation(randomIntersection.street.properties.name, primaryLocation.lat, primaryLocation.lng);
            
            return {
                street1: primaryStreet.properties.name,
                street2: randomIntersection.street.properties.name,
                lat: primaryLocation.lat,
                lng: primaryLocation.lng,
                type1: type1AtLocation,
                type2: type2AtLocation,
                multipleLocations: true,
                locationCount: intersectionLocations.length
            };
        } else {
            const location = intersectionLocations[0];
            console.log(`✓ Selected intersection: ${primaryStreet.properties.name} & ${randomIntersection.street.properties.name} (${Math.round(location.distance)}m apart)`);
            
            validIntersectionLocations = [{
                lat: location.lat,
                lng: location.lng,
                distance: location.distance
            }];
            
            // Get road types at the actual intersection location
            const type1AtLocation = getStreetTypeAtLocation(primaryStreet.properties.name, location.lat, location.lng);
            const type2AtLocation = getStreetTypeAtLocation(randomIntersection.street.properties.name, location.lat, location.lng);
            
            return {
                street1: primaryStreet.properties.name,
                street2: randomIntersection.street.properties.name,
                lat: location.lat,
                lng: location.lng,
                type1: type1AtLocation,
                type2: type2AtLocation,
                multipleLocations: false,
                locationCount: 1
            };
        }
    }
    
    console.log('Could not find valid intersection after trying 20 primary streets');
    return null;
}

function findStreetsClosestApproach(geom1, geom2) {
    const maxDistance = 50; // Maximum 50 meters apart to be considered intersecting
    let closestDistance = Infinity;
    let closestPoint = null;
    
    // Get all line segments from both geometries
    const lines1 = geom1.type === 'LineString' ? [geom1.coordinates] : geom1.coordinates;
    const lines2 = geom2.type === 'LineString' ? [geom2.coordinates] : geom2.coordinates;
    
    lines1.forEach(line1 => {
        lines2.forEach(line2 => {
            // Check every segment against every other segment
            for (let i = 0; i < line1.length - 1; i++) {
                for (let j = 0; j < line2.length - 1; j++) {
                    const seg1Start = line1[i];
                    const seg1End = line1[i + 1];
                    const seg2Start = line2[j];
                    const seg2End = line2[j + 1];
                    
                    const closestPoints = getClosestPointsBetweenSegments(
                        seg1Start, seg1End, seg2Start, seg2End
                    );
                    
                    const distance = calculateDistanceMeters(
                        closestPoints.point1[1], closestPoints.point1[0],
                        closestPoints.point2[1], closestPoints.point2[0]
                    );
                    
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        // Use midpoint between the two closest points
                        closestPoint = {
                            lat: (closestPoints.point1[1] + closestPoints.point2[1]) / 2,
                            lng: (closestPoints.point1[0] + closestPoints.point2[0]) / 2,
                            distance: distance
                        };
                    }
                }
            }
        });
    });
    
    // Only return if streets are close enough to be considered intersecting
    if (closestDistance <= maxDistance) {
        return closestPoint;
    }
    
    return null;
}

function getClosestPointsBetweenSegments(seg1Start, seg1End, seg2Start, seg2End) {
    // Find closest points between two line segments
    const [x1, y1] = seg1Start;
    const [x2, y2] = seg1End;
    const [x3, y3] = seg2Start;
    const [x4, y4] = seg2End;
    
    const dx1 = x2 - x1;
    const dy1 = y2 - y1;
    const dx2 = x4 - x3;
    const dy2 = y4 - y3;
    
    const denom = dx1 * dx2 + dy1 * dy2;
    const len1Sq = dx1 * dx1 + dy1 * dy1;
    const len2Sq = dx2 * dx2 + dy2 * dy2;
    
    let t1 = 0, t2 = 0;
    
    if (len1Sq > 0) {
        t1 = Math.max(0, Math.min(1, ((x3 - x1) * dx1 + (y3 - y1) * dy1) / len1Sq));
    }
    
    if (len2Sq > 0) {
        t2 = Math.max(0, Math.min(1, ((x1 - x3) * dx2 + (y1 - y3) * dy2) / len2Sq));
    }
    
    const point1 = [x1 + t1 * dx1, y1 + t1 * dy1];
    const point2 = [x3 + t2 * dx2, y3 + t2 * dy2];
    
    return { point1, point2 };
}

function findLineIntersections(geom1, geom2, tolerance) {
    const intersections = [];
    
    const lines1 = geom1.type === 'LineString' ? [geom1.coordinates] : geom1.coordinates;
    const lines2 = geom2.type === 'LineString' ? [geom2.coordinates] : geom2.coordinates;
    
    lines1.forEach(line1 => {
        lines2.forEach(line2 => {
            for (let i = 0; i < line1.length - 1; i++) {
                for (let j = 0; j < line2.length - 1; j++) {
                    const seg1 = [line1[i], line1[i + 1]];
                    const seg2 = [line2[j], line2[j + 1]];
                    
                    const intersection = getLineSegmentIntersection(seg1, seg2);
                    if (intersection) {
                        // Check if intersection is close to an endpoint (likely a real intersection)
                        const isNearEndpoint = [seg1[0], seg1[1], seg2[0], seg2[1]].some(point => {
                            const dist = calculateDistanceMeters(intersection.lat, intersection.lng, point[1], point[0]);
                            return dist < tolerance * 111000; // Convert to meters
                        });
                        
                        if (isNearEndpoint) {
                            intersections.push(intersection);
                        }
                    }
                }
            }
        });
    });
    
    return intersections;
}

function getLineSegmentIntersection(seg1, seg2) {
    const [[x1, y1], [x2, y2]] = seg1;
    const [[x3, y3], [x4, y4]] = seg2;
    
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-10) return null; // Parallel lines
    
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            lng: x1 + t * (x2 - x1),
            lat: y1 + t * (y2 - y1)
        };
    }
    
    return null;
}

function nextIntersection() {
    currentIntersection = generateRandomIntersection();
    hasPlacedGuess = false;
    
    // Remove previous guess marker
    if (userGuessMarker) {
        userGuessMarker.remove();
        userGuessMarker = null;
    }
    
    // Update UI with null checks
    const submitBtn = document.getElementById('submit-guess-btn');
    const instructions = document.querySelector('.intersection-instructions');
    const targetIntersection = document.getElementById('target-intersection');
    
    if (currentIntersection) {
        if (targetIntersection) {
            let displayText = `${currentIntersection.street1} & ${currentIntersection.street2}`;
            if (currentIntersection.multipleLocations) {
                displayText += ` (${currentIntersection.locationCount} locations)`;
            }
            targetIntersection.textContent = displayText;
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            const instructionText = currentIntersection.multipleLocations 
                ? 'Click near any intersection of these streets'
                : 'Click on the map to place your guess';
            instructions.textContent = instructionText;
        }
    } else {
        if (targetIntersection) {
            // Check if we have no street data at all vs just no more intersections
            if (!streetData || streetData.features.length === 0) {
                targetIntersection.textContent = 'Click "Configure" to load a city first';
            } else {
                targetIntersection.textContent = 'No more intersections available!';
            }
        }
        if (submitBtn) submitBtn.style.display = 'none';
        if (instructions) {
            if (!streetData || streetData.features.length === 0) {
                instructions.textContent = 'Load an area to start finding intersections';
            } else {
                instructions.textContent = 'Try changing difficulty or loading a different area';
            }
        }
    }
}

// --- INTERSECTION CLICK HANDLING (Pin System) ---
function handleMapClick(e) {
    if (gameMode !== 'intersections' || !currentIntersection) return;
    
    const clickLat = e.lngLat.lat;
    const clickLng = e.lngLat.lng;
    
    // Remove previous guess marker if exists
    if (userGuessMarker) {
        userGuessMarker.remove();
    }
    
    // Place new guess marker
    userGuessMarker = new mapboxgl.Marker({ color: '#ff6464' })
        .setLngLat([clickLng, clickLat])
        .addTo(map);
    
    hasPlacedGuess = true;
    
    // Show submit button and update instructions with null checks
    const submitBtn = document.getElementById('submit-guess-btn');
    const instructions = document.querySelector('.intersection-instructions');
    
    if (submitBtn) submitBtn.style.display = 'inline-block';
    if (instructions) instructions.textContent = 'Click Submit Guess or press Enter to confirm';
}

function submitGuess() {
    if (!currentIntersection || !hasPlacedGuess || !userGuessMarker) return;
    
    const guessLngLat = userGuessMarker.getLngLat();
    const clickLat = guessLngLat.lat;
    const clickLng = guessLngLat.lng;
    
    // Find the closest valid intersection location
    let closestDistance = Infinity;
    let bestLocation = validIntersectionLocations[0];
    
    validIntersectionLocations.forEach(location => {
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
    validIntersectionLocations.forEach((location, index) => {
        const color = index === validIntersectionLocations.indexOf(bestLocation) ? '#00c8ff' : '#00ff88';
        const marker = new mapboxgl.Marker({ color: color })
            .setLngLat([location.lng, location.lat])
            .addTo(map);
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
    if (map.getSource('guess-line')) {
        map.removeLayer('guess-line');
        map.removeSource('guess-line');
    }
    
    map.addSource('guess-line', {
        type: 'geojson',
        data: lineData
    });
    
    map.addLayer({
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
    const key = `${currentIntersection.street1}|${currentIntersection.street2}`;
    foundIntersections.add(key);
    intersectionScore += points;
    intersectionAccuracy.push(closestDistance);
    
    // Show accuracy feedback
    showAccuracyFeedback(closestDistance, points);
    
    // Update stats
    updateStats();
    
    // Clean up after delay and get next intersection
    setTimeout(() => {
        // Remove markers and line
        if (userGuessMarker) {
            userGuessMarker.remove();
            userGuessMarker = null;
        }
        actualMarkers.forEach(marker => marker.remove());
        
        if (map.getSource('guess-line')) {
            map.removeLayer('guess-line');
            map.removeSource('guess-line');
        }
        
        nextIntersection();
    }, 3000);
}

function showAccuracyFeedback(distanceMeters, points) {
    const accuracyDisplay = document.getElementById('accuracy-display');
    const accuracyMeters = document.getElementById('accuracy-meters');
    const accuracyPoints = document.getElementById('accuracy-points');
    
    if (accuracyMeters) accuracyMeters.textContent = Math.round(distanceMeters);
    if (accuracyPoints) accuracyPoints.textContent = points;
    
    if (accuracyDisplay) {
        accuracyDisplay.classList.add('show');
        setTimeout(() => {
            accuracyDisplay.classList.remove('show');
        }, 2000);
    }
}

// --- CITY BOUNDARIES & GEOCODING ---
function createFallbackBoundary(cityData) {
    const lat = cityData.lat;
    const lon = cityData.lon;
    let latOffset, lonOffset;
    
    switch (cityData.placeType) {
        case 'city':
        case 'town':
            latOffset = 0.12;
            lonOffset = 0.15;
            break;
        case 'village':
        case 'municipality':
            latOffset = 0.08;
            lonOffset = 0.10;
            break;
        case 'neighbourhood':
        case 'suburb':
            latOffset = 0.02;
            lonOffset = 0.02;
            break;
        case 'quarter':
        case 'district':
            latOffset = 0.03;
            lonOffset = 0.04;
            break;
        case 'borough':
        case 'ward':
            latOffset = 0.05;
            lonOffset = 0.06;
            break;
        case 'county':
        case 'state_district':
            latOffset = 0.20;
            lonOffset = 0.25;
            break;
        default:
            latOffset = 0.04;
            lonOffset = 0.04;
    }
    
    console.log(`Creating ${cityData.placeType} boundary for ${cityData.name} with size ${latOffset}°×${lonOffset}°`);
    
    return {
        type: 'Polygon',
        coordinates: [[
            [lon - lonOffset, lat - latOffset],
            [lon + lonOffset, lat - latOffset],
            [lon + lonOffset, lat + latOffset],
            [lon - lonOffset, lat + latOffset],
            [lon - lonOffset, lat - latOffset]
        ]]
    };
}

function calculateLineStringLength(coordinates) {
    let length = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        const [lon1, lat1] = coordinates[i]; 
        const [lon2, lat2] = coordinates[i + 1];
        length += calculateDistance(lat1, lon1, lat2, lon2);
    }
    return length;
}

async function searchCities(query) {
    if (!query || query.length < 2) return [];
    
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=8`);
        const results = await response.json();
        
        return results.filter(result => {
            return result.osm_type && result.osm_id && 
                   (result.class === 'place' || 
                    result.class === 'boundary' ||
                    result.class === 'admin' ||
                    ['city', 'town', 'village', 'municipality', 'neighbourhood', 
                     'suburb', 'quarter', 'district', 'borough', 'ward', 'subdivision', 
                     'hamlet', 'locality', 'county', 'state_district'].includes(result.type));
        }).map(result => ({
            name: result.display_name.split(',')[0],
            fullName: result.display_name,
            lat: parseFloat(result.lat),
            lon: parseFloat(result.lon),
            osmId: result.osm_id,
            osmType: result.osm_type,
            placeType: result.type,
            placeClass: result.class,
            importance: result.importance || 0
        }))
        .sort((a, b) => (b.importance || 0) - (a.importance || 0));
    } catch (error) {
        console.error('Error searching cities:', error);
        return [];
    }
}

async function getCityBoundaries(osmType, osmId, cityData = null) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/lookup?format=json&osm_ids=${osmType[0].toUpperCase()}${osmId}&polygon_geojson=1`);
        const results = await response.json();
        
        if (results.length > 0 && results[0].geojson) {
            const geojson = results[0].geojson;
            
            if (isValidBoundary(geojson)) {
                console.log('Found valid official boundaries for', cityData?.name || 'location');
                return geojson;
            } else {
                console.log('API returned boundaries but they are invalid/empty for', cityData?.name || 'location');
            }
        } else {
            console.log('No boundary data returned from API for', cityData?.name || 'location');
        }
        
        console.log('Creating fallback boundary for', cityData?.name || 'location');
        if (cityData) {
            return createFallbackBoundary(cityData);
        }
        
        return null;
    } catch (error) {
        console.error('Error fetching city boundaries:', error);
        if (cityData) {
            console.log('Creating fallback boundary due to API error');
            return createFallbackBoundary(cityData);
        }
        return null;
    }
}

function isValidBoundary(geojson) {
    if (!geojson || !geojson.type) return false;
    
    try {
        let coordinates;
        
        if (geojson.type === 'Polygon') {
            coordinates = geojson.coordinates;
        } else if (geojson.type === 'MultiPolygon') {
            coordinates = geojson.coordinates;
        } else {
            console.log('Boundary type not supported:', geojson.type);
            return false;
        }
        
        if (!coordinates || coordinates.length === 0) {
            console.log('No coordinates in boundary data');
            return false;
        }
        
        let ring;
        if (geojson.type === 'Polygon') {
            ring = coordinates[0];
        } else if (geojson.type === 'MultiPolygon') {
            ring = coordinates[0] && coordinates[0][0];
        }
        
        if (!ring || ring.length < 4) {
            console.log('Boundary ring has insufficient points:', ring?.length || 0);
            return false;
        }
        
        const hasValidCoords = ring.some(coord => 
            Array.isArray(coord) && 
            coord.length >= 2 && 
            Math.abs(coord[0]) > 0.001 && 
            Math.abs(coord[1]) > 0.001
        );
        
        if (!hasValidCoords) {
            console.log('Boundary coordinates appear to be invalid or all zeros');
            return false;
        }
        
        console.log('Boundary validation passed - found valid boundary with', ring.length, 'points');
        return true;
        
    } catch (error) {
        console.error('Error validating boundary:', error);
        return false;
    }
}

const FALLBACK_SEATTLE = {
    name: 'Seattle',
    fullName: 'Seattle, King County, Washington, United States',
    lat: 47.6062,
    lon: -122.3321,
    osmId: 237662,
    osmType: 'relation'
};

// --- DATA FETCHING & PROCESSING ---
async function fetchStreetsFromOSM(boundaries) {
    if (!boundaries) return { type: 'FeatureCollection', features: [] };
    
    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) return { type: 'FeatureCollection', features: [] };
    
    const coords = mainBoundary.coordinates[0];
    if (coords.length === 0) return { type: 'FeatureCollection', features: [] };
    
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    const bbox = {
        south: Math.min(...lats),
        west: Math.min(...lngs),
        north: Math.max(...lats),
        east: Math.max(...lngs)
    };
    
    const expansion = 0.02;
    bbox.south -= expansion;
    bbox.north += expansion;
    bbox.west -= expansion;
    bbox.east += expansion;
    
    console.log('Fetching streets from main city area bbox:', bbox);
    console.log('Using main boundary with', coords.length, 'coordinate points');
    
    const overpassQuery = `[out:json][timeout:60];(way["highway"~"^(primary|secondary|tertiary|residential|unclassified|trunk|motorway)$"]["name"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
    
    try {
        console.log('Making Overpass API request...');
        const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: overpassQuery });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const osmData = await response.json();
        
        console.log('Overpass API returned', osmData.elements?.length || 0, 'street elements');
        
        return processOSMData(osmData, mainBoundary);
    } catch (error) { 
        console.error('Error fetching OSM data:', error); 
        throw error; 
    }
}

function processOSMData(osmData, boundaries = null) {
    const features = []; 
    const streetGroups = new Map();
    streetSegmentsData = new Map(); // NEW: Initialize detailed segment data
    let totalStreets = 0;
    let filteredStreets = 0;
    let boundaryRejected = 0;
    
    console.log('Processing OSM data - got', osmData.elements?.length || 0, 'elements');
    
    if (!osmData.elements) {
        console.log('No elements in OSM data');
        return { type: 'FeatureCollection', features: [] };
    }
    
    osmData.elements.forEach(element => {
        if (element.type === 'way' && element.tags?.name && element.geometry) {
            totalStreets++;
            const streetName = element.tags.name;
            const coordinates = element.geometry.map(node => [node.lon, node.lat]).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
            if (coordinates.length < 2) return;
            
            if (boundaries) {
                const checkPoints = [];
                
                for (let i = 0; i < coordinates.length; i += Math.max(1, Math.floor(coordinates.length / 5))) {
                    checkPoints.push(coordinates[i]);
                }
                checkPoints.push(coordinates[coordinates.length - 1]);
                
                let pointsInBoundary = 0;
                for (const point of checkPoints) {
                    if (pointInPolygon(point, boundaries)) {
                        pointsInBoundary++;
                    }
                }
                
                if (pointsInBoundary === 0) {
                    boundaryRejected++;
                    return;
                }
            }
            
            filteredStreets++;
            const length = calculateLineStringLength(coordinates);
            if (isNaN(length) || length <= 0) return;
            
            const segmentType = getStreetType(element.tags.highway);
            const segment = { 
                coordinates, 
                length, 
                type: segmentType, 
                highway: element.tags.highway 
            };
            
            // Store in both the grouped data (for features) and detailed segment data
            if (!streetGroups.has(streetName)) streetGroups.set(streetName, []);
            streetGroups.get(streetName).push(segment);
            
            // NEW: Store detailed segment data for location-specific classification
            if (!streetSegmentsData.has(streetName)) streetSegmentsData.set(streetName, []);
            streetSegmentsData.get(streetName).push({
                coordinates: coordinates,
                type: segmentType,
                highway: element.tags.highway,
                length: length
            });
        }
    });
    
    console.log(`Street processing summary:
    - Total ways with names: ${totalStreets}
    - Passed boundary filter: ${filteredStreets}
    - Rejected by boundary: ${boundaryRejected}
    - Final unique streets: ${streetGroups.size}`);
    
    streetGroups.forEach((segments, streetName) => {
        const totalLength = segments.reduce((sum, seg) => sum + seg.length, 0);
        
        // Get the highest classification among all segments of this street
        const streetTypes = segments.map(seg => seg.type);
        const typeHierarchy = ['major', 'primary', 'secondary', 'tertiary', 'residential'];
        let highestType = 'residential';
        
        streetTypes.forEach(type => {
            const currentIndex = typeHierarchy.indexOf(type);
            const highestIndex = typeHierarchy.indexOf(highestType);
            if (currentIndex < highestIndex) { // Lower index = higher priority
                highestType = type;
            }
        });
        
        const properties = { 
            name: streetName, 
            type: highestType,  // Use the highest classification for overall feature
            length: totalLength, 
            highway: segments[0].highway,
            segments: segments.length  // Track how many segments this street has
        };
        
        const geometry = segments.length === 1 ? 
            { type: 'LineString', coordinates: segments[0].coordinates } : 
            { type: 'MultiLineString', coordinates: segments.map(s => s.coordinates) };
            
        features.push({ type: 'Feature', properties, geometry });
    });
    
    // Log some stats about street classifications
    const typeStats = {};
    features.forEach(f => {
        const type = f.properties.type;
        typeStats[type] = (typeStats[type] || 0) + 1;
    });
    console.log('Street type distribution:', typeStats);
    console.log('Detailed segment data stored for', streetSegmentsData.size, 'streets');
    
    return { type: 'FeatureCollection', features };
}

function pointInPolygon(point, polygon) {
    if (!polygon) return true;
    
    const [x, y] = point;
    let inside = false;
    
    try {
        const rings = polygon.type === 'Polygon' ? polygon.coordinates : 
                      polygon.type === 'MultiPolygon' ? polygon.coordinates[0] : [polygon.coordinates];
        
        const ring = rings[0];
        
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
    } catch (error) {
        console.error('Error in point-in-polygon check:', error);
        return true;
    }
    
    return inside;
}

function getStreetType(highway) {
    const major = ['motorway', 'trunk'];
    const primary = ['primary'];
    const secondary = ['secondary'];
    const tertiary = ['tertiary'];
    const residential = ['residential', 'unclassified'];
    
    if (major.includes(highway)) return 'major';
    if (primary.includes(highway)) return 'primary';
    if (secondary.includes(highway)) return 'secondary';
    if (tertiary.includes(highway)) return 'tertiary';
    return 'residential';
}

// --- MAP INITIALIZATION ---
function initMap() {
    map = new mapboxgl.Map({
        container: 'map',
        style: {
            "version": 8,
            "sources": {
                "mapbox": {
                    "type": "vector",
                    "url": "mapbox://mapbox.mapbox-streets-v8"
                }
            },
            "layers": [
                {
                    "id": "background",
                    "type": "background",
                    "paint": {
                        "background-color": "#1a1d29"
                    }
                },
                {
                    "id": "water",
                    "type": "fill",
                    "source": "mapbox",
                    "source-layer": "water",
                    "paint": {
                        "fill-color": "#2c3e50"
                    }
                },
                {
                    "id": "land",
                    "type": "fill",
                    "source": "mapbox", 
                    "source-layer": "landuse",
                    "paint": {
                        "fill-color": "#1e2329"
                    }
                },
                {
                    "id": "buildings",
                    "type": "fill",
                    "source": "mapbox",
                    "source-layer": "building",
                    "paint": {
                        "fill-color": "#2a2d35",
                        "fill-opacity": 0.6
                    }
                }
            ]
        },
        center: GAME_CENTER,
        zoom: 13,
        pitch: 0,
        bearing: 0
    });

    map.on('load', () => {
        console.log('Map loaded - ready for user to configure location');
        
        // Hide loading screen since we're not loading any data
        setLoadingState(false);
        
        // Show a message to encourage user to configure
        const streetInput = document.getElementById('street-input');
        if (streetInput) {
            streetInput.placeholder = 'Click "Configure" to load a city first';
            streetInput.disabled = true;
        }
    });
    
    // Add click handler for intersection mode
    map.on('click', handleMapClick);
}

async function confirmAndLoadCity() {
    if (!isPreviewMode || !previewCity) {
        if (cityBoundaries) {
            const center = calculateBoundariesCenter(cityBoundaries);
            await loadStreetsForCity(cityBoundaries, center[1], center[0]);
        }
        return;
    }
    
    cityBoundaries = previewCity.boundaries;
    GAME_CENTER = [previewCity.lon, previewCity.lat];
    await loadStreetsForCity(previewCity.boundaries, previewCity.lat, previewCity.lon);
    
    isPreviewMode = false;
    previewCity = null;
    previousGameConfig = null;
    toggleCityConfigMode(false);
    const previewInfo = document.getElementById('preview-info');
    const loadAreaGroup = document.getElementById('load-area-group');
    if (previewInfo) previewInfo.style.display = 'none';
    if (loadAreaGroup) loadAreaGroup.style.display = 'none';
}

function calculateBoundariesCenter(boundaries) {
    const mainBoundary = getLargestPolygon(boundaries);
    const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
    
    if (coords.length === 0) return [0, 0];
    
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    
    return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

async function loadStreetsForCity(boundaries, lat, lng) {
    currentCenter = [lng, lat];
    
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
        streetData = await fetchStreetsFromOSM(boundaries);
        totalLength = streetData.features.reduce((sum, f) => sum + f.properties.length, 0);

        console.log(`Loaded ${streetData.features.length} unique streets with total length ${totalLength.toFixed(2)} miles`);
        console.log(`Detailed segment data available for location-specific road classification`);

        setupCityMapLayers(boundaries, lat, lng);
        
        // Start with first intersection if in intersection mode
        if (gameMode === 'intersections') {
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

function showCityPreview(cityData) {
    console.log("Showing city preview for", cityData.name);
    if (!isPreviewMode) {
        previousGameConfig = {
            boundaries: cityBoundaries,
            center: [...GAME_CENTER]
        };
        
        isPreviewMode = true;
        const btn = document.getElementById('set-center-btn');
        btn.textContent = 'Cancel';
        btn.classList.add('preview');
        
        const previewInfo = document.getElementById('preview-info');
        if (previewInfo) {
            previewInfo.style.display = 'block';
        }
        
        document.getElementById('load-area-group').style.display = 'block';
    }
    
    const mainBoundary = getLargestPolygon(cityData.boundaries);
    
    const previewInfo = document.getElementById('preview-info');
    if (previewInfo) {
        const locationType = cityData.placeType ? 
            cityData.placeType.charAt(0).toUpperCase() + cityData.placeType.slice(1) : 'Area';
        
        const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
        const isLikelyFallback = coords && coords.length === 5 && isRectangular(coords);
        const boundaryType = isLikelyFallback ? 'generated' : 'official';
        
        let boundaryInfo = boundaryType;
        if (cityData.boundaries.type === 'MultiPolygon') {
            const totalParts = cityData.boundaries.coordinates.length;
            boundaryInfo += ` (main area of ${totalParts} parts)`;
        }
        
        console.log(`${locationType} boundary (${boundaryInfo}) preview shown. Click "Load New Area" to start the game.`);
        previewInfo.textContent = `${locationType} boundary (${boundaryInfo}) preview shown. Click "Load New Area" to start the game.`;
    }
    
    previewCity = {
        ...cityData,
        boundaries: mainBoundary
    };
    
    setupCityPreview(cityData.boundaries);
    
    if (mainBoundary) {
        const coords = mainBoundary.coordinates[0];
        if (coords.length > 0) {
            const bounds = new mapboxgl.LngLatBounds();
            coords.forEach(coord => bounds.extend(coord));
            map.fitBounds(bounds, { padding: 50, duration: 1500 });
        }
    }
}

function isRectangular(coords) {
    if (coords.length !== 5) return false;
    
    const uniqueCoords = coords.slice(0, 4);
    const lngs = uniqueCoords.map(c => c[0]);
    const lats = uniqueCoords.map(c => c[1]);
    
    const uniqueLngs = [...new Set(lngs.map(lng => Math.round(lng * 10000) / 10000))];
    const uniqueLats = [...new Set(lats.map(lat => Math.round(lat * 10000) / 10000))];
    
    return uniqueLngs.length === 2 && uniqueLats.length === 2;
}

function setupCityPreview(boundaries) {
    ['city-boundary-fill', 'city-boundary-line'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource('city-boundary')) map.removeSource('city-boundary');

    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) return;

    map.addSource('city-boundary', { 
        type: 'geojson', 
        data: { type: 'Feature', geometry: mainBoundary, properties: {} } 
    });
    map.addLayer({ 
        id: 'city-boundary-fill', 
        type: 'fill', 
        source: 'city-boundary', 
        paint: { 'fill-color': '#ffa500', 'fill-opacity': 0.15 } 
    });
    map.addLayer({ 
        id: 'city-boundary-line', 
        type: 'line', 
        source: 'city-boundary', 
        paint: { 'line-color': '#ffa500', 'line-width': 3, 'line-opacity': 0.8 } 
    });
}

function setupCityMapLayers(boundaries, lat, lng) {
    if (!map) return;
    
    ['city-boundary-fill', 'city-boundary-line', 'streets-unfound', 'streets-found', 'street-highlight'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    ['city-boundary', 'streets', 'street-highlight-source'].forEach(id => {
        if (map.getSource(id)) map.removeSource(id);
    });

    const mainBoundary = getLargestPolygon(boundaries);
    if (!mainBoundary) return;
    
    map.addSource('city-boundary', { 
        type: 'geojson', 
        data: { type: 'Feature', geometry: mainBoundary, properties: {} } 
    });
    map.addLayer({ 
        id: 'city-boundary-fill', 
        type: 'fill', 
        source: 'city-boundary', 
        paint: { 'fill-color': '#00c8ff', 'fill-opacity': 0.1 } 
    });
    map.addLayer({ 
        id: 'city-boundary-line', 
        type: 'line', 
        source: 'city-boundary', 
        paint: { 'line-color': '#00c8ff', 'line-width': 2, 'line-opacity': 0.8 } 
    });
    
    map.addSource('streets', { type: 'geojson', data: streetData });
    map.addLayer({ 
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
    map.addLayer({ 
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
    
    map.addSource('street-highlight-source', { 
        type: 'geojson', 
        data: { type: 'FeatureCollection', features: [] } 
    });
    map.addLayer({ 
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
        map.fitBounds(bounds, { padding: 50, duration: 1500 });
    }
}

// --- STREET HIGHLIGHTING ---
function highlightStreet(streetName) {
    if (!streetData) return;
    
    const streetFeatures = streetData.features.filter(f => f.properties.name === streetName);
    if (streetFeatures.length === 0) return;
    
    map.getSource('street-highlight-source').setData({
        type: 'FeatureCollection',
        features: streetFeatures
    });
}

function clearHighlight() {
    if (map.getSource('street-highlight-source')) {
        map.getSource('street-highlight-source').setData({
            type: 'FeatureCollection',
            features: []
        });
    }
}

// --- STREET NAME TOOLTIP ---
function showStreetTooltip(e, streetName) {
    if (!document.getElementById('show-street-names-toggle').checked) return;
    
    const tooltip = document.getElementById('street-tooltip');
    tooltip.textContent = streetName;
    tooltip.style.display = 'block';
    tooltip.style.left = e.point.x + 'px';
    tooltip.style.top = e.point.y + 'px';
}

function hideStreetTooltip() {
    const tooltip = document.getElementById('street-tooltip');
    tooltip.style.display = 'none';
}

function setupStreetHoverEvents() {
    if (!map.getLayer('streets-found') || !map.getLayer('streets-unfound')) return;

    map.on('mouseenter', 'streets-found', (e) => {
        if (e.features.length > 0) {
            map.getCanvas().style.cursor = 'pointer';
            showStreetTooltip(e, e.features[0].properties.name);
        }
    });

    map.on('mouseleave', 'streets-found', () => {
        map.getCanvas().style.cursor = '';
        hideStreetTooltip();
    });

    map.on('mouseenter', 'streets-unfound', (e) => {
        if (e.features.length > 0 && document.getElementById('show-unfound-toggle').checked) {
            map.getCanvas().style.cursor = 'pointer';
            showStreetTooltip(e, e.features[0].properties.name);
        }
    });

    map.on('mouseleave', 'streets-unfound', () => {
        map.getCanvas().style.cursor = '';
        hideStreetTooltip();
    });
}

// --- SEARCH FUNCTIONALITY ---
function filterFoundItems(searchTerm) {
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

// --- STREET GAME LOGIC ---
function normalizeStreetName(name) {
    const originalLower = name.toLowerCase();
    const allSuffixes = /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|place|pl|court|ct|way|square|sq|circle|cir|trail|tr|parkway|pkwy|bridge)\b/g;
    const genericSuffixesOnly = /\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd)\b/g;
    const directionals = /\b(north|south|east|west|northeast|northwest|southeast|southwest|n|s|e|w|ne|nw|se|sw)\b/g;
    let normalized = originalLower.replace(directionals, '').replace(allSuffixes, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normalized === '') {
        normalized = originalLower.replace(directionals, '').replace(genericSuffixesOnly, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return normalized;
}

function findAllMatchingStreets(inputName) {
    if (!streetData || !inputName) return [];
    
    const inputLower = inputName.toLowerCase();
    const exactMatches = streetData.features.filter(f => f.properties.name.toLowerCase() === inputLower);
    
    if (exactMatches.length > 0) {
        return exactMatches;
    }
    
    const inputNormalized = normalizeStreetName(inputName);
    if (!inputNormalized) return [];
    return streetData.features.filter(f => normalizeStreetName(f.properties.name) === inputNormalized);
}

function getStreetBounds(streetName) {
    if (!streetData) return null;
    
    const streetFeatures = streetData.features.filter(f => f.properties.name === streetName);
    if (streetFeatures.length === 0) return null;
    
    let bounds = new mapboxgl.LngLatBounds();
    
    streetFeatures.forEach(feature => {
        if (feature.geometry.type === 'LineString') {
            feature.geometry.coordinates.forEach(coord => bounds.extend(coord));
        } else if (feature.geometry.type === 'MultiLineString') {
            feature.geometry.coordinates.forEach(line => {
                line.forEach(coord => bounds.extend(coord));
            });
        }
    });
    
    return bounds;
}

function handleStreetInput(inputValue = null) {
    const inputField = document.getElementById('street-input');
    let value = inputValue ?? inputField.value.trim();
    if (!value || !streetData) return;
    
    const numberMatch = value.match(/^\d+$/);
    if (numberMatch && !inputValue) {
        const number = parseInt(numberMatch[0]);
        value = number + getOrdinalSuffix(number);
        inputField.value = value;
    }
    
    const matchedStreets = findAllMatchingStreets(value);
    let newStreetsFound = false;
    let streetsToAdd = [];
    
    if (matchedStreets.length > 0) {
        for (const street of matchedStreets) {
            const streetKey = street.properties.name.toLowerCase();
            if (!foundStreets.has(streetKey)) {
                streetsToAdd.push(street.properties.name);
                newStreetsFound = true;
            }
        }
        
        if (newStreetsFound) {
            saveState();
            
            streetsToAdd.forEach(streetName => {
                foundStreets.add(streetName.toLowerCase());
                addStreetToList(streetName, false);
            });
            
            updateFoundStreetsLayer();
            updateStats();
            showMessage(`Found ${matchedStreets.length} street(s) for "${value}"!`, 'success');
        } else {
            showMessage(`You already found all streets for "${value}"!`, 'error');
        }
    } else if (!inputValue) {
        showMessage('Street not found. Try a different name or spelling.', 'error');
    }
    if (!inputValue) inputField.value = '';
    return newStreetsFound;
}

function getOrdinalSuffix(i) {
    const j = i % 10, k = i % 100;
    if (j == 1 && k != 11) return "st";
    if (j == 2 && k != 12) return "nd";
    if (j == 3 && k != 13) return "rd";
    return "th";
}

function autofillNumberedStreets() {
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
            if (!foundStreets.has(streetKey)) {
                streetsToAdd.push(street.properties.name);
                foundAny = true;
            }
        }
    }
    
    if (foundAny) {
        saveState();
        
        streetsToAdd.forEach(streetName => {
            foundStreets.add(streetName.toLowerCase());
            addStreetToList(streetName, false);
        });
        
        updateFoundStreetsLayer();
        updateStats();
        showMessage(`Found ${streetsToAdd.length} numbered streets in range ${from}-${to}.`, 'success');
    } else {
        showMessage(`No new numbered streets found in range ${from}-${to}.`, 'error');
    }
}

function updateFoundStreetsLayer() {
    const foundStreetNames = Array.from(foundStreets).map(key => streetData.features.find(f => f.properties.name.toLowerCase() === key)?.properties.name).filter(Boolean);
    map.setFilter('streets-found', ['in', ['get', 'name'], ['literal', foundStreetNames]]);
    map.setPaintProperty('streets-found', 'line-opacity', 1);
}

// --- STATS UPDATE (updated for both modes) ---
function updateStats() {
    if (!streetData) return;
    
    const scoreElement = document.getElementById('score');
    
    if (gameMode === 'streets') {
        const foundLength = streetData.features.filter(f => foundStreets.has(f.properties.name.toLowerCase())).reduce((sum, f) => sum + f.properties.length, 0);
        const distancePercentage = totalLength > 0 ? (foundLength / totalLength * 100).toFixed(2) : '0.00';
        const countPercentage = streetData.features.length > 0 ? (foundStreets.size / streetData.features.length * 100).toFixed(2) : '0.00';
        
        if (scoreElement) scoreElement.textContent = `${distancePercentage}%`;
        
        const foundCountEl = document.getElementById('found-count');
        const totalCountEl = document.getElementById('total-count');
        if (foundCountEl) foundCountEl.textContent = foundStreets.size;
        if (totalCountEl) totalCountEl.textContent = streetData.features.length;
        
        const countPercentageEl = document.getElementById('count-percentage');
        if (countPercentageEl) {
            countPercentageEl.textContent = `${countPercentage}%`;
        }
        
        const totalDistanceEl = document.getElementById('total-distance');
        if (totalDistanceEl) {
            totalDistanceEl.textContent = totalLength.toFixed(1);
        }
    } else if (gameMode === 'intersections') {
        const avgAccuracy = intersectionAccuracy.length > 0 ? 
            intersectionAccuracy.reduce((sum, acc) => sum + acc, 0) / intersectionAccuracy.length : 0;
        
        // Only show the main score - average accuracy in meters
        if (scoreElement) scoreElement.textContent = `${Math.round(avgAccuracy)}m`;
    }
}

// --- UNDO/REDO SYSTEM ---
function saveState() {
    const state = {
        foundStreets: new Set(foundStreets),
        foundIntersections: new Set(foundIntersections),
        timestamp: Date.now()
    };
    
    undoHistory.push(state);
    if (undoHistory.length > maxHistorySize) {
        undoHistory.shift();
    }
    
    redoHistory = [];
    updateUndoRedoButtons();
}

function undo() {
    if (undoHistory.length === 0) return;
    
    const currentState = {
        foundStreets: new Set(foundStreets),
        foundIntersections: new Set(foundIntersections),
        timestamp: Date.now()
    };
    redoHistory.push(currentState);
    
    const prevState = undoHistory.pop();
    foundStreets = new Set(prevState.foundStreets);
    foundIntersections = new Set(prevState.foundIntersections);
    
    rebuildFoundItemsList();
    if (gameMode === 'streets') {
        updateFoundStreetsLayer();
    }
    updateStats();
    updateUndoRedoButtons();
}

function redo() {
    if (redoHistory.length === 0) return;
    
    const currentState = {
        foundStreets: new Set(foundStreets),
        foundIntersections: new Set(foundIntersections),
        timestamp: Date.now()
    };
    undoHistory.push(currentState);
    
    const nextState = redoHistory.pop();
    foundStreets = new Set(nextState.foundStreets);
    foundIntersections = new Set(nextState.foundIntersections);
    
    rebuildFoundItemsList();
    if (gameMode === 'streets') {
        updateFoundStreetsLayer();
    }
    updateStats();
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    // No physical buttons to update anymore
}

function rebuildFoundItemsList() {
    const list = document.getElementById('found-items-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    if (gameMode === 'streets') {
        const foundStreetNames = Array.from(foundStreets).map(key => 
            streetData.features.find(f => f.properties.name.toLowerCase() === key)?.properties.name
        ).filter(Boolean);
        
        foundStreetNames.forEach(streetName => {
            addStreetToList(streetName, false);
        });
    }
    // No rebuild for intersections since we don't show the list
}

function deleteStreet(streetName) {
    const streetKey = streetName.toLowerCase();
    if (foundStreets.has(streetKey)) {
        saveState();
        foundStreets.delete(streetKey);
        
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

// --- CITY SEARCH & UI ---
async function handleCitySearch(query) {
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
            await selectCity(city);
        });
        
        suggestionsDiv.appendChild(suggestion);
    });
    
    suggestionsDiv.style.display = 'block';
}

async function selectCity(city) {
    try {
        setLoadingState(true, `Fetching boundaries for ${city.name}...`);
        const boundaries = await getCityBoundaries(city.osmType, city.osmId, city);
        
        if (boundaries) {
            console.log(`Successfully got boundaries for ${city.name}`);
            showCityPreview({
                ...city,
                boundaries: boundaries
            });
        } else {
            showMessage('Could not create boundaries for this location. Try a different place.', 'error');
        }
    } catch (error) {
        console.error('Error fetching city boundaries:', error);
        showMessage('Error fetching location data. Try again.', 'error');
    } finally {
        setLoadingState(false);
    }
}

function resetGame(fullReload = true) {
    if (!streetData) return;
    foundStreets.clear();
    foundIntersections.clear();
    intersectionScore = 0;
    intersectionAccuracy = [];
    hasPlacedGuess = false;
    validIntersectionLocations = [];
    
    // Clean up intersection mode elements
    if (userGuessMarker) {
        userGuessMarker.remove();
        userGuessMarker = null;
    }
    
    if (map.getSource('guess-line')) {
        map.removeLayer('guess-line');
        map.removeSource('guess-line');
    }
    
    // Only clear the found items list if we're in streets mode
    if (gameMode === 'streets') {
        const foundItemsList = document.getElementById('found-items-list');
        const itemSearch = document.getElementById('item-search');
        
        if (foundItemsList) foundItemsList.innerHTML = '';
        if (itemSearch) itemSearch.value = '';
    }
    
    undoHistory = [];
    redoHistory = [];
    updateUndoRedoButtons();
    
    if (map.getLayer('streets-found')) {
        map.setFilter('streets-found', ['in', ['get', 'name'], ['literal', []]]);
    }
    
    clearHighlight();
    
    if (gameMode === 'intersections') {
        nextIntersection();
    }
    
    updateStats();
    if (fullReload) {
        if (cityBoundaries) {
            const center = calculateBoundariesCenter(cityBoundaries);
            loadStreetsForCity(cityBoundaries, center[1], center[0]);
        }
    } else {
        if (currentCenter) {
            map.flyTo({ center: currentCenter, zoom: 10, duration: 1000 });
        }
    }
    const messageElement = document.getElementById('message');
    if (messageElement) messageElement.classList.remove('show');
}

function showMessage(text, type) {
    const messageDiv = document.getElementById('message');
    if (!messageDiv) return;
    
    messageDiv.textContent = text;
    messageDiv.className = `message ${type} show`;
    setTimeout(() => messageDiv.classList.remove('show'), 3000);
}

function addStreetToList(streetName, saveToHistory = true) {
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
        
        holdTimeout = setTimeout(() => {
            // Extended hold behavior could go here
        }, 1000);
    });
    
    item.addEventListener('mouseup', () => {
        item.classList.remove('holding');
        clearHighlight();
        if (holdTimeout) {
            clearTimeout(holdTimeout);
            holdTimeout = null;
        }
    });
    
    item.addEventListener('mouseleave', () => {
        item.classList.remove('holding');
        clearHighlight();
        if (holdTimeout) {
            clearTimeout(holdTimeout);
            holdTimeout = null;
        }
    });
    
    nameSpan.addEventListener('dblclick', () => {
        const bounds = getStreetBounds(streetName);
        if (bounds) {
            map.fitBounds(bounds, {
                padding: 50,
                maxZoom: 16,
                duration: 1000
            });
        }
    });
    
    list.prepend(item);
}

function toggleCityConfigMode(forceState = null) {
    console.log('toggleCityConfigMode called, isSettingCenter:', isSettingCenter);
    isSettingCenter = forceState ?? !isSettingCenter;
    const btn = document.getElementById('set-center-btn');
    
    if (!isSettingCenter) {
        console.log('Canceling city config mode');
        if (isPreviewMode && previousGameConfig) {
            cityBoundaries = previousGameConfig.boundaries;
            GAME_CENTER = [...previousGameConfig.center];
            
            if (streetData && cityBoundaries) {
                const center = calculateBoundariesCenter(cityBoundaries);
                setupCityMapLayers(cityBoundaries, center[1], center[0]);
            }
        }
        
        isPreviewMode = false;
        previewCity = null;
        previousGameConfig = null;
        btn.textContent = 'Configure';
        btn.classList.remove('active', 'preview');
        
        const previewInfo = document.getElementById('preview-info');
        const cityInputGroup = document.getElementById('city-input-group');
        const loadAreaGroup = document.getElementById('load-area-group');
        const cityInput = document.getElementById('city-input');
        const citySuggestions = document.getElementById('city-suggestions');
        
        if (previewInfo) previewInfo.style.display = 'none';
        if (cityInputGroup) {
            console.log('Hiding city input group');
            cityInputGroup.style.display = 'none';
        }
        if (loadAreaGroup) loadAreaGroup.style.display = 'none';
        
        if (cityInput) cityInput.value = '';
        if (citySuggestions) citySuggestions.style.display = 'none';
        
        if (!streetData) {
            ['city-boundary-fill', 'city-boundary-line'].forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
            if (map.getSource('city-boundary')) map.removeSource('city-boundary');
        }
    } else {
        console.log('Activating city config mode');
        btn.textContent = 'Cancel';
        btn.classList.add('active');
        
        const cityInputGroup = document.getElementById('city-input-group');
        console.log('cityInputGroup element:', cityInputGroup);
        
        if (cityInputGroup) {
            console.log('Showing city input group');
            cityInputGroup.style.display = 'block';
            
            setTimeout(() => {
                const cityInput = document.getElementById('city-input');
                console.log('cityInput element:', cityInput);
                if (cityInput) {
                    cityInput.focus();
                    console.log('Focused on city input');
                }
            }, 100);
        } else {
            console.error('cityInputGroup element not found!');
        }
    }
    
    // Update difficulty dropdown visibility when configure mode changes
    updateDifficultyVisibility();
}

function setLoadingState(isLoading, text = '') {
    const screen = document.getElementById('loading-screen');
    const textEl = document.getElementById('loading-text');
    const inputs = ['street-input', 'reset-btn', 'load-area-btn', 'set-center-btn', 'autofill-btn'];
    
    if (screen) {
        if (isLoading) {
            screen.classList.remove('hidden');
        } else {
            screen.classList.add('hidden');
        }
    }
    
    if (textEl && isLoading) {
        textEl.textContent = text;
    }
    
    inputs.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = isLoading;
    });
}

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
            intersectionDifficulty = e.target.value;
            if (streetData && gameMode === 'intersections') {
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
            if(map.getLayer('streets-unfound')) {
                map.setPaintProperty('streets-unfound', 'line-opacity', e.target.checked ? 0.2 : 0);
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
        if (e.key === 'Enter' && gameMode === 'intersections' && hasPlacedGuess) {
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
    
    // Initialize mode UI
    updateModeUI();
});