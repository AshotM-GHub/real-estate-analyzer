export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const APIFY_TOKEN = process.env.APIFY_TOKEN;

  try {
    // Use run-sync endpoint - waits for result, no polling needed
    const response = await fetch(
      `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=55`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchUrls: [{ url: `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/` }],
          maxItems: 5
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Apify error: ' + err });
    }

    const items = await response.json();
    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'No listings found for this address' });
    }

    const p = items[0];
    return res.status(200).json({
      price: p.price || p.unformattedPrice || null,
      rent: p.rentZestimate || null,
      zestimate: p.zestimate || null,
      taxes: p.propertyTaxRate ? Math.round(p.propertyTaxRate * (p.unformattedPrice || 0) / 100) : null,
      hoa: p.hoaFee || null,
      beds: p.bedrooms || null,
      baths: p.bathrooms || null,
      sqft: p.livingArea || null,
      address: p.address || null,
      url: p.url || null
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
