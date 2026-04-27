// usePrintableQuote — zustand store that holds the current snapshot
// of QuoteDeliveryV4's render-ready data so the QuotePage Print
// button (one component up the tree) can generate a PDF without
// prop-drilling 12 separate arrays.
//
// QuoteDeliveryV4 calls setSnapshot whenever its computed render
// state changes; QuotePage reads snapshot on click. Snapshot is
// cleared on unmount so a stale Print click on the wrong session
// can't generate a misleading PDF.

import { create } from 'zustand';
import type { PrintableQuote } from '@/lib/quotePdf';

interface PrintableQuoteState {
  snapshot: PrintableQuote | null;
  setSnapshot: (s: PrintableQuote | null) => void;
}

export const usePrintableQuote = create<PrintableQuoteState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));
