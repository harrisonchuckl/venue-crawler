// selectors.config.js (CommonJS)

module.exports = {
  TagVenue: {
    // Page 1 of UK event venues (server-rendered; supports ?page=2,3,...)
    startUrl:
      'https://www.tagvenue.com/uk/search/event-venue?neighbourhood=London%2C%20United%20Kingdom&items_per_page=36&page=1&room_tag=event-venue&iso_country_code=GB&view=results',

    // Card links point to /rooms/...
    listItemSelector: 'a[href*="/rooms/"], .c-room-card a[href*="/rooms/"]',

    // We’ll increment this query parameter
    pageParam: 'page',

    // Site label (goes into the "source" field sent to the sheet)
    brand: 'TagVenue',

    // Safety limit (site shows ~277 pages right now)
    hardMaxPages: 300
  },

  HireSpace: {
    // Page 1 of UK venues (supports &page=2,3,...)
    startUrl:
      'https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&page=1&perPage=36&sort=relevance',

    // Card links point to /Spaces/..., sometimes /Space/ too
    listItemSelector: 'a[href*="/Spaces/"], a[href*="/Space/"]',

    pageParam: 'page',
    brand: 'HireSpace',
    hardMaxPages: 400
  }
};
