const fs = require('node:fs/promises');
const path = require('node:path');

const communities = [
    'Вільнянська міська громада, Запорізька область',
    'Оріхівська міська громада, Запорізька область',
    'Гуляйпільська міська громада, Запорізька область',
    'Василівська міська громада, Запорізька область',
    'Степногірська селищна громада, Запорізька область',
    'Новомиколаївська селищна громада, Запорізька область',
    'Токмацька міська громада, Запорізька область'
];
const geojsonFile = path.join(__dirname, 'districts.geojson');
const requestDelayMs = 2000;

function normalizeName(value) {
    return String(value || '').trim().toLocaleLowerCase('uk-UA');
}

function getFeatureName(query) {
    return query.replace(/ громада, Запорізька область$/u, '');
}

function hasPolygonGeometry(geometry) {
    return geometry
        && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
        && Array.isArray(geometry.coordinates)
        && geometry.coordinates.length > 0;
}

async function fetchCommunity(query) {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
        q: query,
        polygon_geojson: '1',
        extratags: '1',
        format: 'json',
        limit: '10'
    }).toString();

    const response = await fetch(url, {
        headers: { 'User-Agent': 'ZpRadar community boundary downloader' }
    });
    if (!response.ok) {
        throw new Error(`Nominatim повернув HTTP ${response.status}`);
    }

    const results = await response.json();
    const result = results.find(item =>
        item.osm_type === 'relation'
        && item.extratags?.admin_level === '7'
        && hasPolygonGeometry(item.geojson)
    );
    if (!result) {
        throw new Error('не знайдено полігон relation з admin_level=7');
    }

    return result.geojson;
}

async function downloadCommunities() {
    const geojson = JSON.parse(await fs.readFile(geojsonFile, 'utf8'));
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        throw new Error('districts.geojson має бути GeoJSON FeatureCollection з масивом features');
    }

    const existingNames = new Set(
        geojson.features
            .filter(feature => feature.properties?.feature_type === 'district')
            .map(feature => normalizeName(feature.properties.name))
    );
    const failedCommunities = [];

    for (let index = 0; index < communities.length; index += 1) {
        const query = communities[index];
        const name = getFeatureName(query);

        if (existingNames.has(normalizeName(name))) {
            console.log(`⚠️ ${name} вже є у файлі.`);
        } else {
            console.log(`Шукаю громаду admin_level=7: ${query}...`);
            try {
                const geometry = await fetchCommunity(query);
                geojson.features.push({
                    type: 'Feature',
                    properties: { name, feature_type: 'district' },
                    geometry
                });
                existingNames.add(normalizeName(name));
                console.log(`✅ ${name} додано.`);
            } catch (error) {
                failedCommunities.push(name);
                console.error(`❌ Не вдалося завантажити ${name}: ${error.message}`);
            }
        }

        if (index < communities.length - 1) {
            await new Promise(resolve => setTimeout(resolve, requestDelayMs));
        }
    }

    const tempFile = `${geojsonFile}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
    await fs.rename(tempFile, geojsonFile);
    console.log(`Оновлено ${geojsonFile}.`);

    if (failedCommunities.length) {
        throw new Error(`Не вдалося завантажити громади: ${failedCommunities.join(', ')}`);
    }
}

downloadCommunities().catch(error => {
    console.error(`Помилка оновлення GeoJSON: ${error.message}`);
    process.exitCode = 1;
});
