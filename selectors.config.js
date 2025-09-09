const BRANDS = {
  TagVenue: {
    // Simple paged URL; we’ll increment &page=
    urlForPage: (p = 1) =>
      `https://www.tagvenue.com/uk/search/event-venue?page=${p}`,
    waitFor: 'a[data-qa="space-card-link"], a[data-qa="venue-card-link"], a[href*="/space/"], a[href*="/venues/"]',
    linkSelector:
      'a[data-qa="space-card-link"], a[data-qa="venue-card-link"], a[href*="/space/"], a[href*="/venues/"]'
  },

  HireSpace: {
    urlForPage: (p = 1) =>
      `https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&perPage=36&sort=relevance&page=${p}`,
    waitFor: 'a[href*="/Spaces/"], a[href*="/Space/"]',
    linkSelector: 'a[href*="/Spaces/"], a[href*="/Space/"]'
  }
};

export default BRANDS;
