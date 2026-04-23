import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  Client,
  Medication,
  NoteType,
  Provider,
  SessionMode,
  SessionNote,
  SessionState,
} from '@/types/session';
import type { BenefitFilterState, BenefitKey } from '@/types/plans';

function uid(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${Date.now().toString(36)}${r}` : `${Date.now().toString(36)}${r}`;
}

function emptyClient(): Client {
  return {
    name: '',
    phone: '',
    dob: '',
    zip: '',
    county: '',
    state: null,
    planType: null,
    medicaidConfirmed: false,
  };
}

function emptyBenefitFilters(): BenefitFilterState {
  const off = {
    enabled: false,
    subToggles: {},
    tier: 'any' as const,
  };
  return {
    dental: { ...off },
    vision: { ...off },
    hearing: { ...off },
    transportation: { ...off },
    otc: { ...off },
    food_card: { ...off },
    diabetic: { ...off },
    fitness: { ...off },
  };
}

function initialState(): SessionState & { benefitFilters: BenefitFilterState } {
  return {
    sessionId: uid('ses'),
    startedAt: Date.now(),
    mode: 'new_quote',
    client: emptyClient(),
    medications: [],
    providers: [],
    notes: [],
    plansCompared: [],
    recommendation: null,
    complianceChecked: [],
    disclaimersConfirmed: [],
    currentPlanId: null,
    selectedFinalists: [],
    benefitFilters: emptyBenefitFilters(),
  };
}

interface SessionStore extends SessionState {
  benefitFilters: BenefitFilterState;
  setMode: (mode: SessionMode) => void;
  updateClient: (patch: Partial<Client>) => void;
  addMedication: (med: Omit<Medication, 'id' | 'addedAt'>) => string;
  updateMedication: (id: string, patch: Partial<Medication>) => void;
  removeMedication: (id: string) => void;
  addProvider: (p: Omit<Provider, 'id' | 'addedAt'>) => string;
  updateProvider: (id: string, patch: Partial<Provider>) => void;
  removeProvider: (id: string) => void;
  addNote: (type: NoteType, body: string, opts?: { carrier?: string; scenario?: string }) => void;
  removeNote: (id: string) => void;
  setCurrentPlanId: (id: string | null) => void;
  setBenefitFilter: (key: BenefitKey, patch: Partial<import('@/types/plans').BenefitFilter>) => void;
  resetBenefitFilters: () => void;
  setSelectedFinalists: (ids: string[]) => void;
  setRecommendation: (id: string | null) => void;
  toggleComplianceItem: (id: string) => void;
  confirmDisclaimer: (id: string) => void;
  resetSession: () => void;
}

export const useSession = create<SessionStore>()(
  persist(
    (set) => ({
      ...initialState(),

      setMode: (mode) => set({ mode }),

      updateClient: (patch) =>
        set((state) => ({ client: { ...state.client, ...patch } })),

      addMedication: (med) => {
        const id = uid('med');
        set((state) => ({
          medications: [
            ...state.medications,
            { ...med, id, addedAt: Date.now() },
          ],
        }));
        return id;
      },

      updateMedication: (id, patch) =>
        set((state) => ({
          medications: state.medications.map((m) =>
            m.id === id ? { ...m, ...patch } : m,
          ),
        })),

      removeMedication: (id) =>
        set((state) => ({
          medications: state.medications.filter((m) => m.id !== id),
        })),

      addProvider: (p) => {
        const id = uid('prv');
        set((state) => ({
          providers: [
            ...state.providers,
            { ...p, id, addedAt: Date.now() },
          ],
        }));
        return id;
      },

      updateProvider: (id, patch) =>
        set((state) => ({
          providers: state.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),

      removeProvider: (id) =>
        set((state) => ({
          providers: state.providers.filter((p) => p.id !== id),
        })),

      addNote: (type, body, opts) => {
        const trimmed = body.trim();
        if (!trimmed) return;
        set((state) => ({
          notes: [
            {
              id: uid('note'),
              type,
              body: trimmed,
              createdAt: Date.now(),
              ...(opts?.carrier ? { carrier: opts.carrier } : {}),
              ...(opts?.scenario ? { scenario: opts.scenario } : {}),
            },
            ...state.notes,
          ],
        }));
      },

      removeNote: (id) =>
        set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),

      setCurrentPlanId: (id) => set({ currentPlanId: id }),

      setBenefitFilter: (key, patch) =>
        set((state) => ({
          benefitFilters: {
            ...state.benefitFilters,
            [key]: { ...state.benefitFilters[key], ...patch },
          },
        })),

      resetBenefitFilters: () => set({ benefitFilters: emptyBenefitFilters() }),

      setSelectedFinalists: (ids) => set({ selectedFinalists: ids }),

      setRecommendation: (id) => set({ recommendation: id }),

      toggleComplianceItem: (id) =>
        set((state) => ({
          complianceChecked: state.complianceChecked.includes(id)
            ? state.complianceChecked.filter((x) => x !== id)
            : [...state.complianceChecked, id],
        })),

      confirmDisclaimer: (id) =>
        set((state) => ({
          disclaimersConfirmed: state.disclaimersConfirmed.includes(id)
            ? state.disclaimersConfirmed
            : [...state.disclaimersConfirmed, id],
        })),

      resetSession: () => set(initialState()),
    }),
    {
      // Safety-net persistence: notes survive a page refresh mid-session.
      // Key and partialize intentionally scope this to notes only — the rest
      // of the session (client intake, meds, providers, plans, compliance)
      // is intentionally ephemeral and re-entered per session.
      name: 'pm_session_notes',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ notes: state.notes }),
    },
  ),
);

export const selectNotes = (s: SessionStore): SessionNote[] => s.notes;
export const selectNoteCount = (s: SessionStore): number => s.notes.length;
