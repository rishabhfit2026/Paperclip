import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

export function JoinRequestQueue() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");
  const [requestType, setRequestType] = useState<"all" | "human" | "agent">("all");
  const [magicLinksByRequestId, setMagicLinksByRequestId] = useState<Record<string, string>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Inbox", href: "/inbox" },
      { label: "Join Requests" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const requestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", `${status}:${requestType}`),
    queryFn: () =>
      accessApi.listJoinRequests(
        selectedCompanyId!,
        status,
        requestType === "all" ? undefined : requestType,
      ),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async (approved, requestId) => {
      if (approved.magicLinkUrl) {
        setMagicLinksByRequestId((prev) => ({ ...prev, [requestId]: approved.magicLinkUrl! }));
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!) });
      pushToast({
        title: "Join request approved",
        body: approved.magicLinkUrl ? "Copy the access link below and send it to them." : undefined,
        tone: "success",
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      pushToast({ title: "Join request rejected", tone: "success" });
    },
  });

  const generateAccessLinkMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.generateJoinRequestAccessLink(selectedCompanyId!, requestId),
    onSuccess: (result, requestId) => {
      setMagicLinksByRequestId((prev) => ({ ...prev, [requestId]: result.magicLinkUrl }));
      pushToast({ title: "Access link generated", body: "Copy it below and send it to them.", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Couldn't generate access link",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to review join requests.</div>;
  }

  if (requestsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading join requests…</div>;
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError && requestsQuery.error.status === 403
        ? "You do not have permission to review join requests for this company."
        : requestsQuery.error instanceof Error
          ? requestsQuery.error.message
          : "Failed to load join requests.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Join Request Queue</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Review human and agent join requests outside the mixed inbox feed. This queue uses the same approval mutations as the inline inbox cards.
        </p>
      </div>

      <Card className="flex-row flex-wrap gap-3 p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Status</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "pending_approval" | "approved" | "rejected")
            }
          >
            <option value="pending_approval">Pending approval</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">Request type</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as "all" | "human" | "agent")
            }
          >
            <option value="all">All</option>
            <option value="human">Human</option>
            <option value="agent">Agent</option>
          </select>
        </label>
      </Card>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            No join requests match the current filters.
          </div>
        ) : (
          requestsQuery.data!.map((request) => (
            <Card key={request.id} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={request.status === "pending_approval" ? "secondary" : request.status === "approved" ? "outline" : "destructive"}>
                      {request.status.replace("_", " ")}
                    </Badge>
                    <Badge variant="outline">{request.requestType}</Badge>
                    {request.adapterType ? <Badge variant="outline">{request.adapterType}</Badge> : null}
                    {request.requestType === "human" && request.invite?.restrictedAgentName ? (
                      <Badge variant="secondary">Restricted to {request.invite.restrictedAgentName}</Badge>
                    ) : null}
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requestType === "human"
                        ? request.requesterUser?.name || request.requestEmailSnapshot || request.requestingUserId || "Unknown human requester"
                        : request.agentName || "Unknown agent requester"}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {request.requestType === "human"
                        ? request.requesterUser?.email || request.requestEmailSnapshot || request.requestingUserId
                        : request.capabilities || request.requestIp}
                    </div>
                    {request.requestType === "human" && request.invite?.restrictedAgentName ? (
                      <div className="text-sm text-foreground">
                        Requesting access to <span className="font-medium">{request.invite.restrictedAgentName}</span> only
                      </div>
                    ) : null}
                  </div>
                </div>

                {request.status === "pending_approval" ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => rejectMutation.mutate(request.id)}
                      disabled={rejectMutation.isPending}
                    >
                      Reject
                    </Button>
                    <Button
                      onClick={() => approveMutation.mutate(request.id)}
                      disabled={approveMutation.isPending}
                    >
                      Approve
                    </Button>
                  </div>
                ) : request.status === "approved" &&
                  request.requestType === "human" &&
                  request.invite?.restrictedAgentName ? (
                  <Button
                    variant="outline"
                    onClick={() => generateAccessLinkMutation.mutate(request.id)}
                    disabled={generateAccessLinkMutation.isPending}
                  >
                    {magicLinksByRequestId[request.id] ? "Regenerate access link" : "Generate access link"}
                  </Button>
                ) : null}
              </div>

              {magicLinksByRequestId[request.id] ? (
                <div className="mt-4 space-y-2 rounded-lg border border-border bg-background px-3 py-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Access link — send this to them yourself
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      readOnly
                      value={magicLinksByRequestId[request.id]}
                      onFocus={(event) => event.currentTarget.select()}
                      onClick={(event) => event.currentTarget.select()}
                      className="min-w-0 flex-1 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await copyTextToClipboard(magicLinksByRequestId[request.id]);
                          pushToast({ title: "Access link copied", tone: "success" });
                        } catch {
                          pushToast({ title: "Couldn't copy link", body: "Copy it manually from the field.", tone: "warn" });
                        }
                      }}
                    >
                      <Copy className="h-4 w-4" />
                      Copy link
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    One-time and expires soon — there's no email delivery yet, so relay it yourself.
                  </p>
                </div>
              ) : null}

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">Invite context</div>
                  <div className="mt-2">
                    {request.invite
                      ? `${request.invite.allowedJoinTypes} join invite${request.invite.humanRole ? ` • default role ${request.invite.humanRole}` : ""}`
                      : "Invite metadata unavailable"}
                  </div>
                  {request.invite?.inviteMessage ? (
                    <div className="mt-2 text-foreground">{request.invite.inviteMessage}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">Request details</div>
                  <div className="mt-2">Submitted {new Date(request.createdAt).toLocaleString()}</div>
                  <div>Source IP {request.requestIp}</div>
                  {request.requestType === "agent" && request.capabilities ? <div>{request.capabilities}</div> : null}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
