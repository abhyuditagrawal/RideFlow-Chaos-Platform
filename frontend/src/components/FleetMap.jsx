import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
const ATTRIBUTION = "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors";

// drivers: [{id, lat, lng}], rides: [{rideId, pickup, drop, state}],
// marks: {pickup, drop} for the booking form, onPick(latlng) for map clicks
export default function FleetMap({ drivers = [], rides = [], marks = {}, onPick, className = "map", highlightDriver }) {
  const el = useRef(null);
  const map = useRef(null);
  const layers = useRef(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([19.06, 72.86], 12);
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 16 }).addTo(map.current);
    L.tileLayer(LABELS, { maxZoom: 16, opacity: 0.8 }).addTo(map.current);
    layers.current = L.layerGroup().addTo(map.current);
    map.current.on("click", (e) => pickRef.current && pickRef.current(e.latlng));
    return () => { map.current.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const g = layers.current;
    if (!g) return;
    g.clearLayers();
    rides.forEach((r) => {
      if (!r.pickup || !r.drop) return;
      const color = r.state === "MATCHED" ? "#34d399" : r.state === "PENDING_MATCH" ? "#fbbf24" : r.state === "CANCELLED" ? "#5f6a85" : "#5b8cff";
      L.polyline([[r.pickup.lat, r.pickup.lng], [r.drop.lat, r.drop.lng]], { color, weight: 1.5, opacity: 0.45, dashArray: "4 6" }).addTo(g);
      L.circleMarker([r.pickup.lat, r.pickup.lng], { radius: 3, color, fillColor: color, fillOpacity: 0.9, weight: 0 }).addTo(g);
    });
    drivers.forEach((d) => {
      const hl = d.id === highlightDriver;
      L.circleMarker([d.lat, d.lng], {
        radius: hl ? 9 : 5, color: hl ? "#fff" : "#22d3ee", weight: hl ? 3 : 1.5, fillColor: hl ? "#a78bfa" : "#22d3ee", fillOpacity: 0.85,
      }).bindTooltip(d.id, { direction: "top" }).addTo(g);
    });
    if (marks.pickup) {
      L.circleMarker([marks.pickup.lat, marks.pickup.lng], { radius: 10, color: "#fff", weight: 3, fillColor: "#34d399", fillOpacity: 1 })
        .bindTooltip("Pickup", { permanent: true, direction: "top" }).addTo(g);
    }
    if (marks.drop) {
      L.circleMarker([marks.drop.lat, marks.drop.lng], { radius: 10, color: "#fff", weight: 3, fillColor: "#f472b6", fillOpacity: 1 })
        .bindTooltip("Drop", { permanent: true, direction: "top" }).addTo(g);
    }
    if (marks.pickup && marks.drop) {
      L.polyline([[marks.pickup.lat, marks.pickup.lng], [marks.drop.lat, marks.drop.lng]], { color: "#a78bfa", weight: 3, opacity: 0.9 }).addTo(g);
    }
  }, [drivers, rides, marks, highlightDriver]);

  return <div ref={el} className={className} />;
}
