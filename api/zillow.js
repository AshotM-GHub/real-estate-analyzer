export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const APIFY_TOKEN = process.env.APIFY_TOKEN;

  try {
    // Use run-sync with short timeout - Apify starts fast
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const searchQuery = encodeURIComponent(JSON.stringify({
      pagination: {},
      filterState: { sort: { value: 'globalrelevanceex' } },
      isListVisible: true,
      usersSearchTerm: address
    }));
    const zillowUrl = `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/?searchQueryState=${searchQuery}`;

    const response = await fetch(
      `https://api.apify.com/v2/acts/maxcopell~zillow-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=55&memory=256`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchUrls: [{ url: zillowUrl }], maxItems: 5 }),
        signal: controller.signal
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Apify error: ' + err.substring(0, 200) });
    }

    const items = await response.json();
    if (!items || items.length === 0) return res.status(404).json({ error: 'No listings found' });

    const addr = address.toLowerCase().split(',')[0].toLowerCase();
    const match = items.find(p => p.address && p.address.toLowerCase().includes(addr)) || items[0];

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

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
