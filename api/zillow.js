export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    // Step 1: Search Zillow for the address to get ZPID
    const searchUrl = `https://www.zillow.com/search/easy-pair/?searchQueryState=${encodeURIComponent(JSON.stringify({
      pagination: {},
      usersSearchTerm: address,
      filterState: { sort: { value: 'globalrelevanceex' } },
      isListVisible: true
    }))}`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      }
    });

    const html = await searchRes.text();

    // Extract __NEXT_DATA__ which contains all property data
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return res.status(404).json({ error: 'Could not parse Zillow data' });

    const nextData = JSON.parse(match[1]);
    const results = nextData?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults || [];

    if (!results.length) return res.status(404).json({ error: 'No listings found for this address' });

    // Find best match
    const addrParts = address.toLowerCase().split(',')[0].trim();
    const match2 = results.find(p => p.address && p.address.toLowerCase().includes(addrParts)) || results[0];

    return res.status(200).json({
      price: match2.unformattedPrice || match2.price ? parseInt(String(match2.price || '').replace(/[^0-9]/g, '')) || null : null,
      rent: match2.rentZestimate || null,
      zestimate: match2.zestimate || null,
      taxes: null,
      hoa: null,
      beds: match2.beds || null,
      baths: match2.baths || null,
      sqft: match2.area || null,
      address: match2.address || null,
      url: match2.detailUrl ? 'https://www.zillow.com' + match2.detailUrl : null
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
