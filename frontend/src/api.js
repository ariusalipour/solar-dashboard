export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(url, body, method = "POST") {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Solar-Request": "1" }),
    },
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
  });
  if (response.status === 401 && url !== "/api/login") {
    window.dispatchEvent(new Event("solar-session-expired"));
    throw new ApiError(
      "Your session has expired. Sign in again to continue.",
      401,
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "Unable to load the dashboard. Check your connection and try again.",
      response.status,
    );
  }
  if (!response.ok)
    throw new ApiError(
      typeof data.detail === "string"
        ? data.detail
        : "Unable to save. Check the fields and try again.",
      response.status,
    );
  return data;
}
