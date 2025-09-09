module.exports = {
  TagVenue: {
    url: "https://www.tagvenue.com/uk/search/event-venue?page=PAGE_NUM",
    venueLinkSelector:
      'a[href*="/venues/"], a[href*="/space/"], a[data-qa="space-card-link"], a[data-qa="venue-card-link"]',
    nextPageSelector: 'a[rel="next"], a[aria-label="Next"], a[href*="&page="]',
  },
  HireSpace: {
    url: "https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&page=PAGE_NUM&perPage=36&sort=relevance",
    venueLinkSelector:
      'a[href*="/Spaces/"], a[href*="/Space/"], a[href*="/Venues/"]',
    nextPageSelector: 'a[rel="next"], a[aria-label="Next"], a[href*="page="]',
  },
};
