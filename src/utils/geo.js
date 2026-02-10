
export function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; 
    const dLat = (lat2 - lat1) * Math.PI / 180; 
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c;
}

export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    return calculateDistance(lat1, lon1, lat2, lon2) * 1609.34; // Convert miles to meters
}

export function calculatePolygonArea(coordinates) {
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

export function getLargestPolygon(boundaries) {
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

export function getDistanceToLineString(lat, lng, coordinates) {
    let minDistance = Infinity;
    
    for (let i = 0; i < coordinates.length - 1; i++) {
        const segmentStart = coordinates[i];
        const segmentEnd = coordinates[i + 1];
        const distance = getDistanceToLineSegment(lat, lng, segmentStart, segmentEnd);
        minDistance = Math.min(minDistance, distance);
    }
    
    return minDistance;
}

export function getDistanceToLineSegment(lat, lng, segmentStart, segmentEnd) {
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

export function getClosestPointsBetweenSegments(seg1Start, seg1End, seg2Start, seg2End) {
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

export function getLineSegmentIntersection(seg1, seg2) {
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

export function pointInPolygon(point, polygon) {
    const coords = polygon.type === 'Polygon' ? polygon.coordinates[0] : polygon.coordinates[0][0];
    const x = point[0], y = point[1];
    let inside = false;
    
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
        const xi = coords[i][0], yi = coords[i][1];
        const xj = coords[j][0], yj = coords[j][1];
        
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        
        if (intersect) inside = !inside;
    }
    
    return inside;
}

export function calculateLineStringLength(coordinates) {
    let length = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        const [lon1, lat1] = coordinates[i];
        const [lon2, lat2] = coordinates[i + 1];
        length += calculateDistanceMeters(lat1, lon1, lat2, lon2);
    }
    return length;
}

export function calculateBoundariesCenter(boundaries) {
    const mainBoundary = getLargestPolygon(boundaries);
    const coords = mainBoundary ? mainBoundary.coordinates[0] : [];
    
    if (coords.length === 0) return [0, 0];
    
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    
    return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}
