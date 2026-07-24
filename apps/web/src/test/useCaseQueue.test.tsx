import { act, renderHook, waitFor } from "@testing-library/react";
import { caseQueueQueryKey, useCaseQueue, type CaseQueueResponse } from "../api/useCaseQueue";
import {
  createFetchResponse,
  createQueryAuthWrapper,
  createTestQueryClient,
  tenantId
} from "./query-test-utils";

const firstCase = {
  id: "00000000-0000-4000-8000-000000000701",
  currentStage: "Manager Approval",
  priority: "High",
  dueDate: "2026-07-28",
  onHold: false,
  updatedAt: "2026-07-24T12:00:00.000Z"
} as const;

describe("useCaseQueue", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("uses a tenant and role scoped query key and the Task 1 client", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse({ cases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    const { result } = renderHook(() => useCaseQueue(), { wrapper });

    expect(result.current.queryKey).toEqual(caseQueueQueryKey(tenantId, "Finance Admin"));
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/expense-reports/case-queue",
      expect.objectContaining({
        method: "GET"
      })
    );
    expect(readHeaders(fetchMock, 0).get("Authorization")).toEqual(
      expect.stringMatching(/^Bearer /u)
    );
    expect(readHeaders(fetchMock, 0).get("X-Correlation-Id")).toEqual(expect.any(String));
  });

  it("invalidates the exact query key after a successful advance mutation", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ cases: [firstCase] }))
      .mockResolvedValueOnce(
        createFetchResponse({
          ...firstCase,
          currentStage: "AP Review"
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({ cases: [{ ...firstCase, currentStage: "AP Review" }] })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper(queryClient);
    const { result } = renderHook(() => useCaseQueue(), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await act(async () => {
      await result.current.advanceCase.mutateAsync({ id: firstCase.id });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: caseQueueQueryKey(tenantId, "Finance Admin")
    });
  });

  it("rolls back the optimistic row when advance fails", async () => {
    let rejectAdvance: ((error: Error) => void) | undefined;
    const queryClient = createTestQueryClient();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ cases: [firstCase] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectAdvance = reject;
          })
      )
      .mockResolvedValue(createFetchResponse({ cases: [firstCase] }));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper(queryClient);
    const { result } = renderHook(() => useCaseQueue(), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    let advancePromise: Promise<unknown> | undefined;
    act(() => {
      advancePromise = result.current.advanceCase.mutateAsync({ id: firstCase.id });
    });

    await waitFor(() =>
      expect(readCachedQueue(queryClient).cases[0]?.currentStage).toBe("AP Review")
    );

    await act(async () => {
      rejectAdvance?.(new Error("Synthetic advance failure."));
      await expect(advancePromise).rejects.toThrow("Synthetic advance failure.");
      await waitFor(() =>
        expect(readCachedQueue(queryClient).cases[0]?.currentStage).toBe("Manager Approval")
      );
    });
  });
});

function readCachedQueue(queryClient: ReturnType<typeof createTestQueryClient>): CaseQueueResponse {
  const cachedQueue = queryClient.getQueryData<CaseQueueResponse>(
    caseQueueQueryKey(tenantId, "Finance Admin")
  );

  if (cachedQueue === undefined) {
    throw new Error("Expected Case Queue cache.");
  }

  return cachedQueue;
}

function readHeaders(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  callIndex: number
): Headers {
  const [, init] = fetchMock.mock.calls[callIndex] ?? [];

  if (init === undefined || !("headers" in init) || init.headers === undefined) {
    throw new Error("Expected request headers.");
  }

  return new Headers(init.headers);
}
