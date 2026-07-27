const form = document.querySelector("#lookup-form");
const status = document.querySelector("#status");
const empty = document.querySelector("#empty-state");
const result = document.querySelector("#result");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitLookup();
});

async function submitLookup() {
  status.textContent = "Query in progress";
  status.dataset.kind = "busy";
  result.hidden = true;
  empty.hidden = false;
  const data = new FormData(form);
  const accountId = data.get("account_id");
  const grantId = data.get("grant_id");
  const query = new URLSearchParams({
    account_id: typeof accountId === "string" ? accountId : "",
    grant_id: typeof grantId === "string" ? grantId : "",
  });
  try {
    const response = await fetch(`/api/diagnostics?${query}`, {
      headers: { "x-correlation-id": crypto.randomUUID() },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code ?? "QUERY_FAILED");
    render(body);
    status.textContent = `Ready · ${body.devices.length} devices`;
    status.dataset.kind = "ready";
  } catch (error) {
    status.textContent =
      error instanceof Error && error.message === "ACCESS_DENIED"
        ? "Access denied · verify grant"
        : "Query failed · check identifiers";
    status.dataset.kind = "error";
  }
}

function render(body) {
  result.replaceChildren();
  const deliveryByDevice = new Map(body.delivery.map((item) => [item.deviceId, item]));
  for (const device of body.devices) {
    const delivery = deliveryByDevice.get(device.deviceId) ?? {};
    const strip = document.createElement("dl");
    strip.className = "strip";
    addField(strip, "Device", device.name);
    addField(strip, "Kind", device.kind);
    addField(strip, "Queue", `${delivery.queueCount ?? "0"} / ${delivery.queueBytes ?? "0"} B`);
    addField(strip, "ACK lag", delivery.ackLag ?? "0");
    addField(
      strip,
      "Route",
      `${delivery.homeRegion ?? "unassigned"} · epoch ${delivery.routeEpoch ?? "0"}`,
    );
    result.append(strip);
  }
  empty.hidden = true;
  result.hidden = false;
}

function addField(list, label, value) {
  const group = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = String(value);
  group.append(term, description);
  list.append(group);
}
