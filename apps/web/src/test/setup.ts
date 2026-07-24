import "@testing-library/jest-dom";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;

  interface Window {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.IS_REACT_ACT_ENVIRONMENT = true;
