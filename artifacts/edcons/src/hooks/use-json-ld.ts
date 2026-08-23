import { useEffect } from "react";
import {
  buildOrganizationSchema,
  CORPORATE_FACTS,
} from "@workspace/corporate-facts";

export function useJsonLd(schema: object | object[]) {
  useEffect(() => {
    const schemas = Array.isArray(schema) ? schema : [schema];
    const elements: HTMLScriptElement[] = [];

    for (const s of schemas) {
      const el = document.createElement("script");
      el.type = "application/ld+json";
      el.textContent = JSON.stringify(s);
      document.head.appendChild(el);
      elements.push(el);
    }

    return () => {
      for (const el of elements) {
        if (document.head.contains(el)) document.head.removeChild(el);
      }
    };
  }, [JSON.stringify(schema)]);
}

export const SITE_URL = CORPORATE_FACTS.canonicalUrl;
export const SITE_NAME = CORPORATE_FACTS.name;
export const ORG_SCHEMA = buildOrganizationSchema();
