/** Product pages shaped like real shops' (trimmed), for the link reader's tests. */

/** A plain Product with a brand object, a barcode, an image list and a "you may also like" product. */
export function jsonLdProductPage(options: { canonical?: string; price?: string } = {}): string {
  return `<!doctype html><html><head>
<title>Wool coat | Shop</title>
${options.canonical ? `<link rel="canonical" href="${options.canonical}">` : ''}
<meta property="og:title" content="Wool coat - Shop">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
  {"@type":"Product","name":"Other scarf","url":"/p/scarf","offers":{"@type":"Offer","price":"99","priceCurrency":"SEK"}}
]}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "Product",
  "name": "Wool-blend coat &amp; belt",
  "brand": { "@type": "Brand", "name": "Filippa K" },
  "gtin13": "7350000000009",
  "image": ["https://cdn.shop.example/coat-1.jpg", "https://cdn.shop.example/coat-2.jpg"],
  "url": "/p/wool-coat",
  "offers": {
    "@type": "Offer",
    "price": "${options.price ?? '3 499,00'}",
    "priceCurrency": "SEK",
    "availability": "https://schema.org/InStock"
  }
}
</script>
</head><body><h1>Wool coat</h1></body></html>`;
}

/** @graph with a WebPage and a ProductGroup: sizes as variants, each with its own barcode. */
export const productGroupPage = `<html><head>
<script type='application/ld+json'>
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Jeans"},
  {"@type":"ProductGroup","name":"H&amp;M Straight jeans","brand":"H&amp;M",
   "image":{"@type":"ImageObject","url":"//image.hm.example/jeans.jpg"},
   "hasVariant":[
     {"@type":"Product","name":"Straight jeans W28","gtin":"7350000000016",
      "offers":{"@type":"Offer","price":299.9,"priceCurrency":"SEK","availability":"OutOfStock"}},
     {"@type":"Product","name":"Straight jeans W30","gtin":"7350000000023",
      "offers":{"@type":"Offer","price":249.9,"priceCurrency":"SEK","availability":"https://schema.org/InStock"}}
   ]}
]}
</script></head><body></body></html>`;

/**
 * AggregateOffer in euros, a block with raw line breaks inside a string (a
 * common shop mistake) and a block that's beyond saving.
 */
export const aggregateOfferPage = `<html><head>
<script type="application/ld+json">{ "@type": "Product", "name": "Leather
 loafers", "brand": ["Arket"], "image": "/img/loafers.webp",
 "offers": { "@type": "AggregateOffer", "lowPrice": "89.95", "highPrice": "129", "priceCurrency": "EUR", "offerCount": 3 } }</script>
<script type="application/ld+json">{ this is not json </script>
</head></html>`;

/** Sale price next to the list price in priceSpecification. */
export const salePricePage = `<script type="application/ld+json">
{"@type":"Product","name":"Knit jumper","offers":{"@type":"Offer","availability":"InStock",
 "priceSpecification":[
   {"@type":"UnitPriceSpecification","priceType":"https://schema.org/ListPrice","price":"799.00","priceCurrency":"NOK"},
   {"@type":"UnitPriceSpecification","price":"559.30","priceCurrency":"NOK"}
 ]}}
</script>`;

/** Only Open Graph / product meta tags, Swedish price format, sold out. */
export const metaOnlyPage = `<html><head>
<meta property="og:type" content="product">
<meta property="og:site_name" content="Nelly">
<meta property="og:title" content="Satin slip dress | Nelly">
<meta property="og:image" content="https://nlycdn.example/dress.jpg?w=1200&amp;q=80">
<meta property="product:price:amount" content="1 299,00">
<meta property="product:price:currency" content="sek">
<meta property="product:availability" content="out of stock">
<meta property="product:brand" content="Nelly">
<link rel="canonical" href="https://nelly.example/se/dress-123/">
</head></html>`;

/** A blog post: Open Graph tags but no product. */
export const articlePage = `<html><head>
<meta property="og:type" content="article">
<meta property="og:title" content="Ten ways to wear a trench">
<meta property="og:image" content="https://blog.example/trench.jpg">
</head><body>No product here.</body></html>`;
