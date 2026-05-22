const APIFY_TOKEN = process.env.APIFY_TOKEN;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
    }

  const { address } = req.body;
    if (!address) {
          return res.status(400).json({ error: 'Address required' });
    }

  try {
        // Start Apify actor run
      const startRes = await fetch(
              `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/runs?token=${APIFY_TOKEN}`,
        {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                              searchUrls: [{ url: `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/` }],
                              maxItems: 3
                  })
        }
            );

      const runData = await startRes.json();
        const runId = runData.data.id;
        const datasetId = runData.data.defaultDatasetId;

      // Poll until finished (max 60 seconds)
      for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 5000));
              const statusRes = await fetch(
                        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
                      );
              const statusData = await statusRes.json();
              const status = statusData.data.status;

          if (status === 'SUCCEEDED') {
                    const itemsRes = await fetch(
                                `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`
                              );
                    const items = await itemsRes.json();

                if (!items || items.length === 0) {
                            return res.status(404).json({ error: 'No listings found for this address' });
                }

                const p = items[0];
                    return res.status(200).json({
                                price: p.price || p.listingPrice || p.unformattedPrice || null,
                                rent: p.rentZestimate || null,
                                zestimate: p.zestimate || null,
                                taxes: p.propertyTaxRate ? Math.round(p.propertyTaxRate * (p.price || 0) / 100) : null,
                                hoa: p.hoaFee || null,
                                beds: p.bedrooms || null,
                                baths: p.bathrooms || null,
                                sqft: p.livingArea || null,
                                address: p.address || null,
                                url: p.url || null
                    });
          }

          if (status === 'FAILED' || status === 'ABORTED') {
                    return res.status(500).json({ error: 'Apify run failed' });
          }
      }

      return res.status(504).json({ error: 'Timeout waiting for Zillow data' });

  } catch (error) {
        return res.status(500).json({ error: error.message });
  }
}
