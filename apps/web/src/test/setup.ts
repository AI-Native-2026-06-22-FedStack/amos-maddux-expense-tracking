import "@testing-library/jest-dom";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;

  interface Window {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.IS_REACT_ACT_ENVIRONMENT = true;

const NativeRequest = globalThis.Request;

class RouterTestRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init === undefined ? init : { ...init, signal: undefined });
  }
}

globalThis.Request = RouterTestRequest;
