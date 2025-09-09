// ESM export of all CSS selectors + base URLs used by the crawler.

export const SELECTORS = {
  TagVenue: {
    baseUrl: "https://www.tagvenue.com/uk/search/event-venue",
    pageParam: "page",
    // Links to individual venue/space cards on the search results
    itemLinks: 'a[href*="/rooms/"], a[href*="/venue/"]'
  },

  HireSpace: {
    // UK all-venues search (you can tweak filters here if you want)
    baseUrl:
      "https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ",
    pageParam: "page",
    // Links to space pages on the search results
    itemLinks: 'a[href*="/Spaces/"], a[href*="/Space/"]'
  }
};
