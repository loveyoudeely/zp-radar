import { writeFile } from 'node:fs/promises';

const overpassUrls = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];
const outputPaths = {
    districts: new URL('./districts.geojson', import.meta.url),
    oblast: new URL('./oblast.geojson', import.meta.url)
};
const districts = [
    { name: 'Дніпровський', aliases: ['Дніпровський', 'Дніпровський район', 'Днепровский', 'Днепровский район', 'Dniprovskyi', 'Dniprovskyi District'] },
    { name: 'Хортицький', aliases: ['Хортицький', 'Хортицький район', 'Хортицкий', 'Хортицкий район', 'Khortytskyi', 'Khortytskyi District'] },
    { name: 'Комунарський', aliases: ['Комунарський', 'Комунарський район', 'Коммунарский', 'Коммунарский район', 'Komunarskyi', 'Komunarskyi District'] },
    { name: 'Шевченківський', aliases: ['Шевченківський', 'Шевченківський район', 'Шевченковский', 'Шевченковский район', 'Shevchenkivskyi', 'Shevchenkivskyi District'] },
    { name: 'Олександрівський', aliases: ['Олександрівський', 'Олександрівський район', 'Александровский', 'Александровский район', 'Oleksandrivskyi', 'Oleksandrivskyi District'] },
    { name: 'Вознесенівський', aliases: ['Вознесенівський', 'Вознесенівський район', 'Вознесеновский', 'Вознесеновский район', 'Voznesenivskyi', 'Voznesenivskyi District'] },
    { name: 'Заводський', aliases: ['Заводський', 'Заводський район', 'Заводской', 'Заводской район', 'Zavodskyi', 'Zavodskyi District'] }
];

function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLocaleLowerCase('uk')
        .replace(/\s+район$/u, '')
        .replace(/\s+district$/iu, '')
        .replace(/\s+/gu, ' ');
}

const districtByAlias = new Map();
for (const district of districts) {
    for (const alias of district.aliases) districtByAlias.set(normalizeName(alias), district);
}

const namesPattern = districts
    .flatMap(district => district.aliases)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
const districtQuery = `
[out:json][timeout:180];
(
  relation["boundary"="administrative"]["name"~"^(${namesPattern})$",i](47.70,34.90,47.98,35.40);
  relation["boundary"="administrative"]["name:uk"~"^(${namesPattern})$",i](47.70,34.90,47.98,35.40);
  relation["boundary"="administrative"]["name:en"~"^(${namesPattern})$",i](47.70,34.90,47.98,35.40);
  relation["boundary"="administrative"]["name:ru"~"^(${namesPattern})$",i](47.70,34.90,47.98,35.40);
  relation["name"="Комунарський район"](47.70,34.90,47.98,35.40);
  relation["name:uk"="Комунарський район"](47.70,34.90,47.98,35.40);
);
out body geom;
`;
const oblastNames = ['Запорізька область', 'Запорожская область', 'Zaporizhzhia Oblast'];
const oblastPattern = oblastNames
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
const oblastQuery = `
[out:json][timeout:180];
(
  relation["boundary"="administrative"]["admin_level"="4"]["name"~"^(${oblastPattern})$",i];
  relation["boundary"="administrative"]["admin_level"="4"]["name:uk"~"^(${oblastPattern})$",i];
  relation["boundary"="administrative"]["admin_level"="4"]["name:ru"~"^(${oblastPattern})$",i];
  relation["boundary"="administrative"]["admin_level"="4"]["name:en"~"^(${oblastPattern})$",i];
);
out body geom;
`;
const microdistrictQuery = `
[out:json][timeout:180];
(
  node["place"~"^(neighbourhood|suburb)$"]["name"](47.70,34.90,47.98,35.40);
  way["place"~"^(neighbourhood|suburb)$"]["name"](47.70,34.90,47.98,35.40);
  relation["place"~"^(neighbourhood|suburb)$"]["name"](47.70,34.90,47.98,35.40);
);
out body geom;
`;

function samePoint(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}

function joinRings(ways, districtName, role) {
    const remaining = ways
        .filter(way => Array.isArray(way.geometry) && way.geometry.length >= 2)
        .map(way => way.geometry.map(point => [point.lon, point.lat]));
    const rings = [];

    while (remaining.length) {
        const ring = remaining.shift();
        while (!samePoint(ring[0], ring[ring.length - 1])) {
            const end = ring[ring.length - 1];
            const start = ring[0];
            let match = -1;
            let mode = '';

            for (let index = 0; index < remaining.length; index += 1) {
                const candidate = remaining[index];
                if (samePoint(end, candidate[0])) {
                    match = index;
                    mode = 'append';
                    break;
                }
                if (samePoint(end, candidate[candidate.length - 1])) {
                    match = index;
                    mode = 'append-reversed';
                    break;
                }
                if (samePoint(start, candidate[candidate.length - 1])) {
                    match = index;
                    mode = 'prepend';
                    break;
                }
                if (samePoint(start, candidate[0])) {
                    match = index;
                    mode = 'prepend-reversed';
                    break;
                }
            }

            if (match < 0) {
                throw new Error(`Не удалось собрать замкнутый контур ${role} для района «${districtName}».`);
            }

            let segment = remaining.splice(match, 1)[0];
            if (mode.endsWith('reversed')) segment = segment.reverse();
            if (mode.startsWith('append')) ring.push(...segment.slice(1));
            else ring.unshift(...segment.slice(0, -1));
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
        const crosses = (yi > point[1]) !== (yj > point[1])
            && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
        if (crosses) inside = !inside;
    }
    return inside;
}

function relationToFeature(relation, districtName) {
    const membersByRole = { outer: [], inner: [] };
    for (const member of relation.members || []) {
        if (member.type !== 'way' || !member.geometry) continue;
        const role = member.role === 'inner' ? 'inner' : 'outer';
        membersByRole[role].push(member);
    }

    const outers = joinRings(membersByRole.outer, districtName, 'outer');
    const inners = joinRings(membersByRole.inner, districtName, 'inner');
    if (!outers.length) throw new Error(`У района «${districtName}» нет внешнего контура.`);

    const polygons = outers.map(outer => [outer]);
    for (const inner of inners) {
        const container = outers.findIndex(outer => pointInRing(inner[0], outer));
        if (container < 0) {
            throw new Error(`Не удалось сопоставить внутренний контур района «${districtName}».`);
        }
        polygons[container].push(inner);
    }

    return {
        type: 'Feature',
        properties: {
            name: districtName,
            feature_type: 'district',
            osm_type: 'relation',
            osm_id: relation.id
        },
        geometry: polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] }
            : { type: 'MultiPolygon', coordinates: polygons }
    };
}

function elementName(element) {
    const tags = element.tags || {};
    return tags['name:uk'] || tags.name || tags['name:en'] || tags['name:ru'];
}

function wayToFeature(way) {
    const ring = (way.geometry || []).map(point => [point.lon, point.lat]);
    if (ring.length < 4 || !samePoint(ring[0], ring[ring.length - 1])) return null;

    return {
        type: 'Feature',
        properties: {
            name: elementName(way),
            feature_type: 'microdistrict',
            place: way.tags.place,
            osm_type: 'way',
            osm_id: way.id
        },
        geometry: { type: 'Polygon', coordinates: [ring] }
    };
}

function microdistrictToFeature(element) {
    if (element.type === 'node') {
        return {
            type: 'Feature',
            properties: {
                name: elementName(element),
                feature_type: 'microdistrict',
                place: element.tags?.place,
                osm_type: 'node',
                osm_id: element.id
            },
            geometry: { type: 'Point', coordinates: [element.lon, element.lat] }
        };
    }
    if (element.type === 'way') return wayToFeature(element);
    if (element.type === 'relation') {
        const feature = relationToFeature(element, elementName(element));
        feature.properties.feature_type = 'microdistrict';
        feature.properties.place = element.tags?.place;
        return feature;
    }
    return null;
}

function featureCollection(name, features) {
    return {
        type: 'FeatureCollection',
        name,
        attribution: '© OpenStreetMap contributors, ODbL',
        features
    };
}

async function saveGeoJson(path, name, features) {
    await writeFile(path, `${JSON.stringify(featureCollection(name, features), null, 2)}\n`, 'utf8');
}

async function fetchOverpass(query, timeoutMs = 210_000) {
    const endpointErrors = [];
    for (const overpassUrl of overpassUrls) {
        try {
            const response = await fetch(overpassUrl, {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'user-agent': 'ZpRadar district boundary downloader/1.0'
                },
                body: new URLSearchParams({ data: query }),
                signal: AbortSignal.timeout(timeoutMs)
            });
            if (!response.ok) {
                endpointErrors.push(`${overpassUrl}: HTTP ${response.status}`);
                continue;
            }
            const result = await response.json();
            if (result.remark) throw new Error(`Overpass сообщил об ошибке: ${result.remark}`);
            return result;
        } catch (error) {
            endpointErrors.push(`${overpassUrl}: ${error.message}`);
        }
    }
    throw new Error(`Все серверы Overpass недоступны. ${endpointErrors.join('; ')}`);
}

async function main() {
    const districtResult = await fetchOverpass(districtQuery);
    const relations = (districtResult.elements || []).filter(element => element.type === 'relation');
    const selected = new Map();
    for (const relation of relations) {
        const tags = relation.tags || {};
        const district = [tags['name:uk'], tags.name, tags['name:en'], tags['name:ru']]
            .map(name => districtByAlias.get(normalizeName(name)))
            .find(Boolean);
        if (!district) continue;

        if (selected.has(district.name)) {
            console.warn(`Найдено несколько границ для района «${district.name}»; используется первая (OSM relation ${selected.get(district.name).properties.osm_id}).`);
            continue;
        }

        try {
            selected.set(district.name, relationToFeature(relation, district.name));
        } catch (error) {
            console.error(`Пропущен район «${district.name}» (OSM relation ${relation.id}): ${error.message}`);
        }
    }

    const missing = districts.map(district => district.name).filter(name => !selected.has(name));
    if (missing.length) {
        console.warn(`В Overpass не найдены полигоны районов: ${missing.join(', ')}.`);
    }

    const districtFeatures = districts
        .map(district => selected.get(district.name))
        .filter(Boolean);

    let failed = false;
    let microdistrictFeatures = [];
    try {
        const microdistrictResult = await fetchOverpass(microdistrictQuery, 60_000);
        const seenMicrodistricts = new Set();
        for (const element of microdistrictResult.elements || []) {
            try {
                const feature = microdistrictToFeature(element);
                if (!feature || !feature.properties.name) continue;
                const key = `${feature.properties.osm_type}:${feature.properties.osm_id}`;
                if (seenMicrodistricts.has(key)) continue;
                seenMicrodistricts.add(key);
                microdistrictFeatures.push(feature);
            } catch (error) {
                console.warn(`Пропущен полигон микрорайона ${elementName(element) || element.id}: ${error.message}`);
            }
        }
    } catch (error) {
        failed = true;
        console.error(`Не вдалося завантажити полігони мікрорайонів: ${error.message}`);
    }

    const allFeatures = [...districtFeatures, ...microdistrictFeatures];
    await saveGeoJson(
        outputPaths.districts,
        'Запоріжжя — райони та мікрорайони',
        allFeatures
    );
    console.log(
        `Збережено ${selected.size} із ${districts.length} районів і ${microdistrictFeatures.length} мікрорайонів у ${outputPaths.districts.pathname}`
    );

    try {
        const oblastResult = await fetchOverpass(oblastQuery);
        const oblastRelation = (oblastResult.elements || []).find(element =>
            element.type === 'relation'
            && element.tags?.boundary === 'administrative'
            && element.tags?.admin_level === '4'
        );
        if (!oblastRelation) throw new Error('Не найдена граница Запорожской области (admin_level=4).');
        const oblastFeature = relationToFeature(oblastRelation, 'Запорізька область');
        await saveGeoJson(outputPaths.oblast, 'Запорізька область', [oblastFeature]);
        console.log(`Збережено межу області у ${outputPaths.oblast.pathname}`);
    } catch (error) {
        failed = true;
        console.error(`Не вдалося оновити oblast.geojson: ${error.message}`);
    }

    if (!microdistrictFeatures.length) {
        console.warn('В OSM не найдены объекты place=suburb/neighbourhood с геометрией.');
    }

    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.error(`Не вдалося завантажити межі районів: ${error.message}`);
    process.exitCode = 1;
});