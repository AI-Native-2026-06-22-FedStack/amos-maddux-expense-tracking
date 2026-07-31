export interface TivsRuntimeConfig {
  breakerErrorThresholdPercentage: number;
  breakerResetTimeoutMs: number;
  breakerTimeoutMs: number;
  breakerVolumeThreshold: number;
  endpointUrl: string;
  password?: string;
  port: number;
  username?: string;
  wsdlUrl: string;
}

export function loadTivsRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): TivsRuntimeConfig {
  const wsdlUrl = requireUrl(env.TIVS_WSDL_URL, "TIVS_WSDL_URL");
  const endpointUrl =
    env.TIVS_ENDPOINT_URL === undefined || env.TIVS_ENDPOINT_URL.trim() === ""
      ? endpointUrlFromWsdlUrl(wsdlUrl)
      : requireUrl(env.TIVS_ENDPOINT_URL, "TIVS_ENDPOINT_URL");

  const username = env.TIVS_USERNAME?.trim();
  const password = env.TIVS_PASSWORD;

  if ((username === undefined || username === "") !== (password === undefined)) {
    throw new Error("TIVS_USERNAME and TIVS_PASSWORD must be configured together.");
  }

  return {
    breakerErrorThresholdPercentage: readInteger(
      env.TIVS_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      "TIVS_BREAKER_ERROR_THRESHOLD_PERCENTAGE",
      50
    ),
    breakerResetTimeoutMs: readInteger(
      env.TIVS_BREAKER_RESET_TIMEOUT_MS,
      "TIVS_BREAKER_RESET_TIMEOUT_MS",
      5_000
    ),
    breakerTimeoutMs: readInteger(env.TIVS_BREAKER_TIMEOUT_MS, "TIVS_BREAKER_TIMEOUT_MS", 1_000),
    breakerVolumeThreshold: readInteger(
      env.TIVS_BREAKER_VOLUME_THRESHOLD,
      "TIVS_BREAKER_VOLUME_THRESHOLD",
      3,
      2
    ),
    endpointUrl,
    ...(password === undefined || username === undefined || username === ""
      ? {}
      : { password, username }),
    port: readInteger(env.PORT, "PORT", 3015),
    wsdlUrl
  };
}

function requireUrl(value: string | undefined, variableName: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${variableName} is required.`);
  }

  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${variableName} must be a valid URL.`);
  }
}

function endpointUrlFromWsdlUrl(wsdlUrl: string): string {
  const endpointUrl = new URL(wsdlUrl);
  endpointUrl.search = "";
  endpointUrl.hash = "";

  return endpointUrl.toString();
}

function readInteger(
  value: string | undefined,
  variableName: string,
  defaultValue: number,
  minimumValue = 1
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < minimumValue) {
    throw new Error(`${variableName} must be an integer greater than or equal to ${minimumValue}.`);
  }

  return parsedValue;
}
