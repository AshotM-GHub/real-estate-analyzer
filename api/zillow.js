export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const APIFY_TOKEN = process.env.APIFY_TOKEN;

  try {
    // Build proper Zillow search URL with searchQueryState
    const searchQuery = encodeURIComponent(JSON.stringify({
      pagination: {},
      filterState: { sort: { value: 'globalrelevanceex' } },
      isListVisible: true,
      usersSearchTerm: address
    }));
    const zillowUrl = `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/?searchQueryState=${searchQuery}`;

    // Start actor run
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchUrls: [{ url: zillowUrl }],
          maxItems: 5
        })
      }
    );

    const runData = await startRes.json();
    if (!runData.data) return res.status(500).json({ error: 'Failed to start Apify run: ' + JSON.stringify(runData) });

    const runId = runData.data.id;
    const datasetId = runData.data.defaultDatasetId;

    // Poll until finished (max 55 seconds)
    for (let i = 0; i < 11; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      const statusData = await statusRes.json();
      const status = statusData.data.status;

      if (status === 'SUCCEEDED') {
        const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
        const items = await itemsRes.json();
        if (!items || items.length === 0) return res.status(404).json({ error: 'No listings found' });

        // Find best match by address
        const addr = address.toLowerCase();
        const match = items.find(p => p.address && p.address.toLowerCase().includes(addr.split(',')[0].toLowerCase())) || items[0];

        return res.status(200).json({
          price: match.unformattedPrice || null,
          rent: match.rentZestimate || null,
          zestimate: match.zestimate || null,
          taxes: match.propertyTaxRate ? Math.round(match.propertyTaxRate * (match.unformattedPrice || 0) / 100) : null,
          hoa: match.hoaFee || null,
          beds: match.bedrooms || null,
          baths: match.bathrooms || null,
          sqft: match.livingArea || null,
          address: match.address || null,
          url: match.url || null
        });
      }

      if (status === 'FAILED' || status === 'ABORTED') {
        return res.status(500).json({ error: 'Apify run failed with status: ' + status });
      }
    }

    return res.status(504).json({ error: 'Timeout' });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
