export interface TivsRuntimeConfig {
  endpointUrl: string;
  password?: string;
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
    endpointUrl,
    ...(password === undefined || username === undefined || username === ""
      ? {}
      : { password, username }),
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
