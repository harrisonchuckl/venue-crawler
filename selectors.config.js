// All selectors and listing URLs

export const SELECTORS = {
  TagVenue: {
    baseUrl: "https://www.tagvenue.com/uk/search/event-venue",
    pageParam: "page",
    itemLinks: 'a[href*="/rooms/"], a[href*="/venue/"]'
  },

  HireSpace: {
    baseUrl:
      "https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ",
    pageParam: "page",
    itemLinks: 'a[href*="/Spaces/"], a[href*="/Space/"]'
  }
};
