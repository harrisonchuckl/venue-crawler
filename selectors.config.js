export const seeds = {
  TagVenue: [
    // Stable URL pattern with explicit page param
    "https://www.tagvenue.com/uk/search/event-venue?page=1"
  ],
  HireSpace: [
    // Relevance sort shows pages reliably; explicit page param
    "https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&perPage=36&sort=relevance&page=1"
  ]
};

export const listing = {
  TagVenue: {
    // space/venue cards
    venueLinkSelector: 'a[data-qa="space-card-link"], a[data-qa="venue-card-link"], a[href*="/space/"], a[href*="/venues/"]',
    // Try common “next” patterns and generic page param anchors
    nextPageSelector: 'a[rel="next"], a[aria-label="Next"], a[aria-label*="Next"], a[href*="&page="], a[href*="?page="]',
    // A selector we can wait on to confirm the grid rendered
    contentReadySelector: '[data-qa="space-card-link"], .space-card, .venue-card'
  },
  HireSpace: {
    venueLinkSelector: 'a[href*="/Spaces/"], a[href*="/Space/"], a[href*="/Venues/"]',
    nextPageSelector: 'a[rel="next"], a[aria-label="Next"], a[aria-label*="Next"], a[href*="page="]',
    contentReadySelector: '.search-result, [data-test-id="search-results"], a[href*="/Space/"]'
  }
};

export const details = {
  // we’re not deep-crawling detail pages here, but keep fields for parity
  nameSelector: 'h1, .venue-title, [data-qa="venue-name"], [itemprop="name"]',
  citySelector: '.city, [itemprop="addressLocality"], .venue-location'
};
