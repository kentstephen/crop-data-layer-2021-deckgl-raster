import proj4 from "proj4";

// USDA CDL is published in EPSG:5070 (NAD83 / Conus Albers). Registering
// the def here lets pick.ts and stats.ts transform lon/lat <-> 5070 for
// picking and per-tile viewport intersection.
proj4.defs(
  "EPSG:5070",
  "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 " +
    "+x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs",
);

export const lonLatToAlbers = proj4("EPSG:4326", "EPSG:5070");
export const albersToLonLat = proj4("EPSG:5070", "EPSG:4326");

// COGLayer's epsgResolver is a separate concern: it parses the GeoTIFF's
// embedded geokeys into a proj definition (default fetches PROJJSON from
// epsg.io with caching).
export { epsgResolver } from "@developmentseed/proj";
