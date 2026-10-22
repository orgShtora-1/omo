import { expect, test } from "bun:test"
import { type Team, TeamError } from "../../src/teams/model"
import { buildMailboxBlock, decideWake, gateTeamTool, injectMailbox } from "../../src/teams/runtime"

const scope = { projectID: "p", locationID: "/loc", parentSessionID: "parent" }

function team(overrides: Partial<Team> = {}): Team {
  return {
    schemaVersion: 1,
    id: "team",
    scope,
    revision: 1,
    leaderID: "lead",
    members: [
      { id: "lead", active: true },
      { id: "alice", active: true },
      { id: "bob", active: false },
    ],
    tasks: [],
    status: "active",
    ...overrides,
  }
}

test("team gate refuses non-participants, non-leaders and duplicate creation", () => {
  const teams = [team()]
  const shared = { tool: "omo_team", teams, leaderSessionID: "parent" }
  expect(() =>
    gateTeamTool({
      ...shared,
      sessionID: "stranger",
      input: { action: "task_list", teamID: "team" },
    }),
  ).toThrow(TeamError)
  expect(() =>
    gateTeamTool({ ...shared, sessionID: "alice", input: { action: "delete", teamID: "team" } }),
  ).toThrow(/lead-only/)
  expect(() =>
    gateTeamTool({
      ...shared,
      sessionID: "alice",
      input: { action: "shutdown_request", teamID: "team" },
    }),
  ).toThrow(/lead-only/)
  expect(() =>
    gateTeamTool({
      ...shared,
      sessionID: "alice",
      input: { action: "shutdown_approve", teamID: "team" },
    }),
  ).not.toThrow()
  expect(() =>
    gateTeamTool({
      ...shared,
      sessionID: "alice",
      input: { action: "task_list", teamID: "other" },
    }),
  ).toThrow(/unknown-team/)
  expect(() =>
    gateTeamTool({ ...shared, sessionID: "alice", input: { action: "task_list" } }),
  ).toThrow(/team-required/)
  expect(() =>
    gateTeamTool({
      ...shared,
      sessionID: "alice",
      input: { action: "create", teamID: "new-team" },
    }),
  ).toThrow(/already-participates/)
  expect(() =>
    gateTeamTool({ ...shared, sessionID: "parent", input: { action: "create", teamID: "team" } }),
  ).not.toThrow()
  expect(() =>
    gateTeamTool({ ...shared, sessionID: "bob", input: { action: "task_list", teamID: "team" } }),
  ).not.toThrow()
  expect(() =>
    gateTeamTool({
      tool: "omo_parallel",
      sessionID: "stranger",
      teams,
      leaderSessionID: "parent",
      input: {},
    }),
  ).not.toThrow()
  expect(() =>
    gateTeamTool({
      tool: "omo_team",
      sessionID: "alice",
      teams,
      leaderSessionID: "parent",
      input: 7,
    }),
  ).toThrow(/invalid-input/)
})

test("mailbox block lists only unacknowledged messages and injection is marker-deduped", () => {
  const messages = [
    {
      id: "m1",
      teamID: "team",
      senderID: "lead",
      body: "please build",
      createdAt: 1,
      acknowledgedAt: null,
    },
    {
      id: "m2",
      teamID: "team",
      senderID: "alice",
      body: "already read",
      createdAt: 2,
      acknowledgedAt: 3,
    },
    {
      id: "m3",
      teamID: "team",
      senderID: "bob",
      body: "review ready",
      createdAt: 4,
      acknowledgedAt: null,
    },
  ] as Parameters<typeof buildMailboxBlock>[1]
  expect(buildMailboxBlock([team()], messages)).toBe(
    '<team_mailbox team="team" pending="2">\n- m1 from lead: please build\n- m3 from bob: review ready\n</team_mailbox>',
  )
  expect(buildMailboxBlock([team()], [])).toBeNull()
  const context: { messages: unknown[] } = { messages: [] }
  expect(injectMailbox(context.messages, "first", "alice#3")).toBe(true)
  expect(injectMailbox(context.messages, "first again", "alice#3")).toBe(false)
  expect(injectMailbox(context.messages, "next turn", "alice#4")).toBe(true)
  // The host message shape carries no `synthetic` flag: the injected identity is
  // the stable id plus the marker text.
  expect(
    (context.messages[0] as { id?: string; content: { type: string; text: string }[] }).content[0]
      ?.text,
  ).toBe("first")
  expect((context.messages[0] as { role: string }).role).toBe("user")
  expect((context.messages[0] as { id?: string }).id).toBe("omo-team-alice#3")
  expect(injectMailbox(context.messages, "   ", "alice#5")).toBe(false)
})

test("idle wake is bounded, deduplicated by message identity and never wakes for read mail", () => {
  const unread = [
    {
      id: "m1",
      teamID: "team",
      senderID: "lead",
      body: "please build",
      createdAt: 1,
      acknowledgedAt: null,
    },
  ] as Parameters<typeof decideWake>[2]
  const state = { hinted: new Set<string>(), wakes: 0 }
  expect(decideWake(state, "alice", unread, { maxWakes: 3 })).toEqual({
    wake: true,
    pending: unread,
  })
  expect(decideWake(state, "alice", unread, { maxWakes: 3 })).toEqual({
    wake: false,
    pending: unread,
  })
  expect(
    decideWake({ hinted: new Set(unread.map((m) => m.id)), wakes: 0 }, "alice", unread, {
      maxWakes: 3,
    }),
  ).toEqual({
    wake: false,
    pending: unread,
  })
  expect(decideWake(state, "alice", [], { maxWakes: 3 })).toEqual({ wake: false, pending: [] })
  const fresh = [
    {
      id: "m2",
      teamID: "team",
      senderID: "lead",
      body: "and now the review",
      createdAt: 5,
      acknowledgedAt: null,
    },
  ] as Parameters<typeof decideWake>[2]
  expect(decideWake(state, "alice", fresh, { maxWakes: 3, pending: () => undefined })).toEqual({
    wake: false,
    pending: fresh,
  })
  const budgeted = { hinted: new Set<string>(), wakes: 0 }
  for (let index = 1; index <= 3; index++)
    expect(
      decideWake(
        budgeted,
        "alice",
        [
          {
            id: `n${index}`,
            teamID: "team",
            senderID: "lead",
            body: "n",
            createdAt: index,
            acknowledgedAt: null,
          },
        ] as Parameters<typeof decideWake>[2],
        { maxWakes: 3 },
      ),
    ).toEqual({
      wake: true,
      pending: [
        {
          id: `n${index}`,
          teamID: "team",
          senderID: "lead",
          body: "n",
          createdAt: index,
          acknowledgedAt: null,
        },
      ],
    })
  expect(
    decideWake(
      budgeted,
      "alice",
      [
        {
          id: "n4",
          teamID: "team",
          senderID: "lead",
          body: "n",
          createdAt: 4,
          acknowledgedAt: null,
        },
      ] as Parameters<typeof decideWake>[2],
      { maxWakes: 3 },
    ),
  ).toEqual({
    wake: false,
    pending: [
      { id: "n4", teamID: "team", senderID: "lead", body: "n", createdAt: 4, acknowledgedAt: null },
    ],
  })
})
