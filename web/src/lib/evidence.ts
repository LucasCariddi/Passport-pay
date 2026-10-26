// Real testnet evidence shared with the landing, the deck and the .pptx (site/evidence.js).
// Read at build time: the file is a small script whose object is valid JSON.
import source from "../../../site/evidence.js?raw";

export interface Proof {
  tx: string;
  status: "SUCCESS" | "FAILED";
  code?: number;
  error?: string;
  what: string;
  account?: string;
  at?: string;
}

export interface Evidence {
  network: string;
  explorer: string;
  demoAccount: string;
  demoAgentKey: string;
  merchant: string;
  paid: Proof;
  capExceeded: Proof;
  revoked: Proof;
  payeeNotAllowed: Proof;
  injection: (Proof & { model?: string }) | null;
}

export const EVIDENCE: Evidence = JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1));

export const shortTx = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
