---- MODULE WorkUpdateOwnership ----
EXTENDS Naturals

CONSTANTS Me, Other, MaxHumanEdits

Users == {Me, Other}

VARIABLES item, pc, seen, retryVersion, wantsPatch, wantsAddon, humanEdits, landed

vars == <<item, pc, seen, retryVersion, wantsPatch, wantsAddon, humanEdits, landed>>

Mine(i) == i.owner = Me \/ i.assignee = Me

Land(kind) == landed' = landed \cup {[kind |-> kind, mine |-> Mine(item)]}

AfterPatch == IF wantsAddon THEN "addon" ELSE "done"

Init ==
  /\ item \in [owner : Users, assignee : Users, version : {1}]
  /\ seen = item
  /\ pc = "read"
  /\ retryVersion = 0
  /\ wantsPatch \in BOOLEAN
  /\ wantsAddon \in BOOLEAN
  /\ wantsPatch \/ wantsAddon
  /\ humanEdits = 0
  /\ landed = {}

ResolveItem ==
  /\ pc = "read"
  /\ seen' = item
  /\ pc' = "check"
  /\ UNCHANGED <<item, retryVersion, wantsPatch, wantsAddon, humanEdits, landed>>

AssertWritable ==
  /\ pc = "check"
  /\ pc' = IF Mine(seen) THEN (IF wantsPatch THEN "patch" ELSE "addon") ELSE "refused"
  /\ UNCHANGED <<item, seen, retryVersion, wantsPatch, wantsAddon, humanEdits, landed>>

PatchWithSeenVersion ==
  /\ pc = "patch"
  /\ IF seen.version = item.version
       THEN /\ Land("patch")
            /\ item' = [item EXCEPT !.version = @ + 1]
            /\ pc' = AfterPatch
       ELSE /\ pc' = "refetch"
            /\ UNCHANGED <<item, landed>>
  /\ UNCHANGED <<seen, retryVersion, wantsPatch, wantsAddon, humanEdits>>

RefetchVersion ==
  /\ pc = "refetch"
  /\ retryVersion' = item.version
  /\ pc' = "repatch"
  /\ UNCHANGED <<item, seen, wantsPatch, wantsAddon, humanEdits, landed>>

PatchWithFreshVersion ==
  /\ pc = "repatch"
  /\ IF retryVersion = item.version
       THEN /\ Land("retry")
            /\ item' = [item EXCEPT !.version = @ + 1]
            /\ pc' = AfterPatch
       ELSE /\ pc' = "failed"
            /\ UNCHANGED <<item, landed>>
  /\ UNCHANGED <<seen, retryVersion, wantsPatch, wantsAddon, humanEdits>>

PostTaskAddon ==
  /\ pc = "addon"
  /\ Land("addon")
  /\ pc' = "done"
  /\ UNCHANGED <<item, seen, retryVersion, wantsPatch, wantsAddon, humanEdits>>

HumanReassigns(u) ==
  /\ humanEdits < MaxHumanEdits
  /\ u # item.assignee
  /\ item' = [item EXCEPT !.assignee = u, !.version = @ + 1]
  /\ humanEdits' = humanEdits + 1
  /\ UNCHANGED <<pc, seen, retryVersion, wantsPatch, wantsAddon, landed>>

HumanEditsOtherField ==
  /\ humanEdits < MaxHumanEdits
  /\ item' = [item EXCEPT !.version = @ + 1]
  /\ humanEdits' = humanEdits + 1
  /\ UNCHANGED <<pc, seen, retryVersion, wantsPatch, wantsAddon, landed>>

Finished ==
  /\ pc \in {"done", "refused", "failed"}
  /\ UNCHANGED vars

Next ==
  \/ ResolveItem
  \/ AssertWritable
  \/ PatchWithSeenVersion
  \/ RefetchVersion
  \/ PatchWithFreshVersion
  \/ PostTaskAddon
  \/ \E u \in Users : HumanReassigns(u)
  \/ HumanEditsOtherField
  \/ Finished

Spec == Init /\ [][Next]_vars

OwnedAtFirstPatch == \A w \in landed : w.kind = "patch" => w.mine

OwnedAtRetryPatch == \A w \in landed : w.kind = "retry" => w.mine

OwnedAtAddonWrite == \A w \in landed : w.kind = "addon" => w.mine

NoWriteAfterRefusal == pc = "refused" => landed = {}

====
