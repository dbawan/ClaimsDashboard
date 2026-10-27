const compiledBasePath = String(import.meta.env?.BASE_URL || "/").replace(/\/$/, "");

export function pathWithinApp(value = "/", basePath = compiledBasePath) {
  const normalizedBase = String(basePath || "").replace(/\/$/, "");
  const pathValue = String(value || "/").startsWith("/")
    ? String(value || "/")
    : `/${value}`;
  return pathValue === "/" ? `${normalizedBase}/` || "/" : `${normalizedBase}${pathValue}`;
}
