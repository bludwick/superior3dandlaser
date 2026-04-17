exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const q     = ((event.queryStringParameters || {}).q || '').trim();
  const token = process.env.MAPBOX_TOKEN;

  if (!token) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ suggestions: [] }),
    };
  }

  if (q.length < 3) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ suggestions: [] }),
    };
  }

  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
                `?access_token=${token}&country=us&types=address&autocomplete=true&limit=5`;

    const res  = await fetch(url);
    const data = await res.json();

    const suggestions = (data.features || []).map(f => ({
      fullText: f.place_name.replace(/, United States$/, ''),
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ suggestions }),
    };
  } catch (err) {
    console.error('[address-suggest] error:', err.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ suggestions: [] }),
    };
  }
};
