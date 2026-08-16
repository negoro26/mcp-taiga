/**
 * Constants for the Taiga MCP server.
 */

export const SERVER_INFO = {
  name: 'mcp-taiga',
  version: '1.0.0',
};

export const RESOURCE_URIS = {
  PROJECTS: 'taiga://projects',
};

export const API_ENDPOINTS = {
  PROJECTS: '/projects',
  USER_STORIES: '/userstories',
  TASKS: '/tasks',
  ISSUES: '/issues',
  EPICS: '/epics',
  WIKI: '/wiki',
  MILESTONES: '/milestones',
  HISTORY: '/history',
  MEMBERSHIPS: '/memberships',
  USERS: '/users',
  USERS_ME: '/users/me',
  USER_STORY_STATUSES: '/userstory-statuses',
  TASK_STATUSES: '/task-statuses',
  ISSUE_STATUSES: '/issue-statuses',
  EPIC_STATUSES: '/epic-statuses',
  PRIORITIES: '/priorities',
  SEVERITIES: '/severities',
  ISSUE_TYPES: '/issue-types',
  POINTS: '/points',
  ROLES: '/roles',
};

export const ERROR_MESSAGES = {
  MISSING_PROJECT_ID: 'Project identifier is required when using a #reference number',
  EMPTY_BATCH: 'The items array cannot be empty',
  BATCH_TOO_LARGE: 'Batch size exceeds the maximum of',
};

export const SUCCESS_MESSAGES = {
  AUTHENTICATED: 'Successfully authenticated',
  USER_STORY_CREATED: 'User story created',
  TASK_CREATED: 'Task created',
  ISSUE_CREATED: 'Issue created',
  SPRINT_CREATED: 'Sprint created',
  COMMENT_ADDED: 'Comment added',
  COMMENT_EDITED: 'Comment edited',
  COMMENT_DELETED: 'Comment deleted',
  ATTACHMENT_UPLOADED: 'Attachment uploaded',
  ATTACHMENT_DELETED: 'Attachment deleted',
  EPIC_CREATED: 'Epic created',
  EPIC_UPDATED: 'Epic updated',
  STORY_LINKED_TO_EPIC: 'User story linked to epic',
  STORY_UNLINKED_FROM_EPIC: 'User story unlinked from epic',
  WIKI_PAGE_CREATED: 'Wiki page created',
  WIKI_PAGE_UPDATED: 'Wiki page updated',
  WIKI_PAGE_DELETED: 'Wiki page deleted',
};

/** Maximum items accepted by a single batch tool call. */
export const MAX_BATCH_SIZE = 20;

/** Maximum decoded size of an uploaded attachment (10 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const STATUS_LABELS = {
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  UNKNOWN: 'Unknown',
  NOT_SET: 'Not set',
  UNASSIGNED: 'Unassigned',
  NO_SPRINT: 'No Sprint',
  NO_DESCRIPTION: 'No description provided',
  NO_TAGS: 'No tags',
};
