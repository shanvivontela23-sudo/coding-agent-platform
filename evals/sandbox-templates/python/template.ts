import { Template } from "e2b";
import { withCodingHarness } from "../harness.js";

// Python 3.12 with the packaging tools the Python stack skill can select.
// Pin the base image by digest before production use.
export const PYTHON_BASE_IMAGE = "python:3.12-bookworm" as const;
export const PYTHON_TOOLS = ["uv==0.4.30", "poetry==1.8.4", "pipenv==2024.4.0", "build==1.2.2"] as const;

export const pythonHarnessTemplate = withCodingHarness(Template().fromImage(PYTHON_BASE_IMAGE))
  .runCmd(`python -m pip install --no-cache-dir ${PYTHON_TOOLS.join(" ")}`, { user: "root" })
  .runCmd("python --version && uv --version && poetry --version && pipenv --version");
