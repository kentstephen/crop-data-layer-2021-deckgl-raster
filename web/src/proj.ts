// USDA CDL is published in EPSG:5070 (NAD83 / Conus Albers).
//
// We rely on the default epsgResolver from @developmentseed/proj, which
// fetches PROJJSON from epsg.io and caches it. EPSG:5070 is a registered
// code there. If we ever need offline-only operation, swap to a local
// PROJJSON literal + parseWkt() from the same package.
export { epsgResolver } from "@developmentseed/proj";
