
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
  COMMENT_ADDED: 'Comment added',
  COMMENT_EDITED: 'Comment edited',
  COMMENT_DELETED: 'Comment deleted',
};

export const MAX_BATCH_SIZE = 20;

export const MAX_LIST_ROWS = 50;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

