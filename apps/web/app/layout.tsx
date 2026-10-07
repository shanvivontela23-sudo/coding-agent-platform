import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "../src/product-config";
import "./globals.css";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: `${PRODUCT_NAME} turns support requests into reviewed software changes.`,
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
