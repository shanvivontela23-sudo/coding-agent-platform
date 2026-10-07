import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "../src/product-config";
import "./globals.css";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: `${PRODUCT_NAME} turns support requests into reviewed software changes.`,
};

const themeBootstrap = `(() => {
  try {
    const theme = localStorage.getItem("dhara-theme");
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  } catch {}
})();`;

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
