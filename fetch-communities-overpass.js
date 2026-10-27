const fs = require('node:fs/promises');
const path = require('node:path');

const overpassUrl = 'https://overpass-api.de/api/interpreter';
const geojsonFile = path.join(__dirname, 'districts.geojson');
const query = `
[out:json][timeout:180];
area["boundary"="administrative"]["admin_level"="4"]["name"="Запорізька область"]->.oblast;
relation["boundary"="administrative"]["admin_level"="7"](area.oblast)->.communities;
(.communities; way(r.communities););
out body geom;
`;

function normalizeName(value) {
    return String(value || '').trim().toLocaleLowerCase('uk-UA').replace(/\s+/gu, ' ');
}

function cleanCommunityName(value) {
    return String(value || '')
        .replace(/\s+(?:міська|селищна|сільська)?\s*територіальна громада$/iu, '')
        .replace(/\s+громада$/iu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function coordinateKey(point) {
    return `${point.lon},${point.lat}`;
}

function closeRingSegments(segments, relationId, role) {
    const remaining = segments
        .filter(segment =>
            Array.isArray(segment)
            && segment.length >= 2
            && segment.every(point => Number.isFinite(point.lon) && Number.isFinite(point.lat))
        )
        .map(segment => segment.map(point => [point.lon, point.lat]));
    const rings = [];

    while (remaining.length) {
        const ring = remaining.shift();
        let guard = remaining.length + 1;

        while (
            coordinateKey({ lon: ring[ring.length - 1][0], lat: ring[ring.length - 1][1] })
                !== coordinateKey({ lon: ring[0][0], lat: ring[0][1] })
            && guard > 0
        ) {
            guard -= 1;
            const endKey = `${ring[ring.length - 1][0]},${ring[ring.length - 1][1]}`;
            const startKey = `${ring[0][0]},${ring[0][1]}`;
            const nextIndex = remaining.findIndex(segment => {
                const first = `${segment[0][0]},${segment[0][1]}`;
                const last = `${segment[segment.length - 1][0]},${segment[segment.length - 1][1]}`;
                return first === endKey || last === endKey || last === startKey || first === startKey;
            });

            if (nextIndex === -1) {
                throw new Error(`Не вдалося з'єднати кільця ${role} для relation ${relationId}`);
            }

            const [next] = remaining.splice(nextIndex, 1);
            const nextFirst = `${next[0][0]},${next[0][1]}`;
            const nextLast = `${next[next.length - 1][0]},${next[next.length - 1][1]}`;

            if (nextFirst === endKey) {
                ring.push(...next.slice(1));
            } else if (nextLast === endKey) {
                ring.push(...next.reverse().slice(1));
            } else if (nextLast === startKey) {
                ring.unshift(...next.slice(0, -1));
            } else {
                ring.unshift(...next.reverse().slice(0, -1));
            }
        }

        if (ring.length < 4) {
            throw new Error(`Некоректне кільце ${role} для relation ${relationId}`);
        }
        rings.push(ring);
    }

    return rings;
}

function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersects = ((yi > point[1]) !== (yj > point[1]))
            && (point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function relationToFeature(relation, waysById) {
    const name = cleanCommunityName(relation.tags?.['name:uk'] || relation.tags?.name);
    if (!name) {
        throw new Error(`У relation ${relation.id} немає назви`);
    }

    const outerSegments = [];
    const innerSegments = [];
    for (const member of relation.members || []) {
        if (member.type !== 'way') continue;
        const way = waysById.get(member.ref);
        if (!way?.geometry) continue;
        if (member.role === 'inner') innerSegments.push(way.geometry);
        else outerSegments.push(way.geometry);
    }

    const outers = closeRingSegments(outerSegments, relation.id, 'outer');
    const inners = closeRingSegments(innerSegments, relation.id, 'inner');
    if (!outers.length) {
        throw new Error(`У relation ${relation.id} немає зовнішнього полігона`);
    }
    const polygons = outers.map(outer => [outer]);
    for (const inner of inners) {
        const polygonIndex = outers.findIndex(outer => pointInRing(inner[0], outer));
        if (polygonIndex === -1) {
            throw new Error(`Не знайдено зовнішнє кільце для inner relation ${relation.id}`);
        }
        polygons[polygonIndex].push(inner);
    }

    return {
        type: 'Feature',
        properties: {
            name,
            feature_type: 'district',
            osm_type: 'relation',
            osm_id: relation.id
        },
        geometry: polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons }
    };
}

async function fetchCommunities() {
    const response = await fetch(overpassUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'ZpRadar community boundary downloader'
        },
        body: new URLSearchParams({ data: query })
    });
    if (!response.ok) {
        throw new Error(`Overpass API повернув HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.elements)) {
        throw new Error('Overpass API повернув відповідь без масиву elements');
    }

    const waysById = new Map(
        data.elements
            .filter(element => element.type === 'way')
            .map(way => [way.id, way])
    );
    const relations = data.elements.filter(element =>
        element.type === 'relation'
        && element.tags?.boundary === 'administrative'
        && element.tags?.admin_level === '7'
    );
    if (!relations.length) {
        throw new Error('У Запорізькій області не знайдено громад з admin_level=7');
    }

    const features = [];
    const errors = [];
    for (const relation of relations) {
        try {
            features.push(relationToFeature(relation, waysById));
        } catch (error) {
            errors.push(`relation ${relation.id}: ${error.message}`);
        }
    }

    if (errors.length) {
        throw new Error(`Не вдалося конвертувати всі громади:\n${errors.join('\n')}`);
    }
    return features;
}

async function saveCommunities(features) {
    const geojson = JSON.parse(await fs.readFile(geojsonFile, 'utf8'));
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('districts.geojson має бути GeoJSON FeatureCollection з масивом features');
    }

    const communityIds = new Set(features.map(feature => String(feature.properties.osm_id)));
    const communityNames = new Set(features.map(feature => normalizeName(feature.properties.name)));
    const retainedFeatures = geojson.features.filter(feature => {
        if (feature.properties?.feature_type !== 'district') return true;
        const properties = feature.properties;
        return !communityIds.has(String(properties.osm_id))
            && !communityNames.has(normalizeName(properties.name));
    });

    const updatedGeojson = { ...geojson, features: [...retainedFeatures, ...features] };
    const tempFile = `${geojsonFile}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(updatedGeojson, null, 2)}\n`, 'utf8');
    await fs.rename(tempFile, geojsonFile);
}

async function main() {
    const features = await fetchCommunities();
    await saveCommunities(features);
    console.log(`Збережено ${features.length} громад у ${geojsonFile}.`);
}

main().catch(error => {
    console.error(`Помилка завантаження громад: ${error.message}`);
    process.exitCode = 1;
});
