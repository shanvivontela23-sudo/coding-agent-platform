import { Template } from "e2b";
import { withCodingHarness } from "../harness.js";

// .NET 8 SDK image plus the .NET 9 SDK, so projects targeting net8.0 or
// net9.0 build. Pin the base image by digest before production use.
export const DOTNET_BASE_IMAGE = "mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim" as const;
export const DOTNET_EXTRA_CHANNELS = ["9.0"] as const;

export const dotnetHarnessTemplate = withCodingHarness(Template().fromImage(DOTNET_BASE_IMAGE))
  .setEnvs({ DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" })
  .runCmd(`curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && ${DOTNET_EXTRA_CHANNELS.map((channel) => `bash /tmp/dotnet-install.sh --channel ${channel} --install-dir /usr/share/dotnet`).join(" && ")} && rm /tmp/dotnet-install.sh`, { user: "root" })
  .runCmd("dotnet --list-sdks");
