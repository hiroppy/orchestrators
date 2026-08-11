export const ISSUE_STATE_QUERY = `
  query OrchestratorWatcherIssueState($id: String!, $includeCreator: Boolean!) {
    issue(id: $id) {
      identifier
      title
      creator @include(if: $includeCreator) {
        name
        email
      }
      state {
        name
        type
      }
      attachments {
        nodes {
          url
        }
      }
      relations {
        nodes {
          type
          relatedIssue {
            identifier
            title
            url
            state {
              type
            }
          }
        }
      }
      url
    }
  }
`;

export const ISSUE_STATUS_TARGET_QUERY = `
  query OrchestratorWatcherIssueStatusTarget($id: String!) {
    issue(id: $id) {
      id
      team {
        states {
          nodes {
            id
            name
          }
        }
      }
    }
  }
`;

export const ISSUE_STATUS_UPDATE_MUTATION = `
  mutation OrchestratorWatcherIssueStatusUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        state {
          name
        }
      }
    }
  }
`;

export const ISSUE_WORKPAD_QUERY = `
  query OrchestratorWatcherIssueWorkpad($id: String!, $after: String) {
    issue(id: $id) {
      id
      comments(first: 250, after: $after) {
        nodes {
          id
          body
          createdAt
          resolvedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const COMMENT_REPLY_CREATE_MUTATION = `
  mutation OrchestratorWatcherCommentReplyCreate(
    $id: String!
    $issueId: String!
    $parentId: String!
    $body: String!
  ) {
    commentCreate(input: { id: $id, issueId: $issueId, parentId: $parentId, body: $body }) {
      success
    }
  }
`;

export const FILE_UPLOAD_MUTATION = `
  mutation OrchestratorWatcherFileUpload(
    $filename: String!
    $contentType: String!
    $size: Int!
  ) {
    fileUpload(filename: $filename, contentType: $contentType, size: $size) {
      success
      uploadFile {
        uploadUrl
        assetUrl
        headers {
          key
          value
        }
      }
    }
  }
`;

export const COMMENT_BY_ID_QUERY = `
  query OrchestratorWatcherCommentById($id: ID!) {
    comments(first: 1, filter: { id: { eq: $id } }) {
      nodes {
        id
      }
    }
  }
`;

export const TEAM_WORKFLOW_STATES_QUERY = `
  query OrchestratorWatcherTeamWorkflowStates($id: String!) {
    team(id: $id) {
      states {
        nodes {
          name
          type
          position
        }
      }
    }
  }
`;

export const TAKE_PR_TARGET_QUERY = `
  query OrchestratorWatcherTakePrTarget($teamId: String!, $projectSlug: String!) {
    team(id: $teamId) {
      id
      states {
        nodes {
          id
          name
        }
      }
    }
    projects(first: 2, filter: { slugId: { eq: $projectSlug } }) {
      nodes {
        id
        name
        slugId
        teams {
          nodes {
            id
          }
        }
      }
    }
  }
`;

export const TAKE_PR_ISSUE_CREATE_MUTATION = `
  mutation OrchestratorWatcherTakePrIssueCreate(
    $issueId: String!
    $teamId: String!
    $projectId: String!
    $stateId: String!
    $title: String!
    $description: String!
  ) {
    issueCreate(
      input: {
        id: $issueId
        teamId: $teamId
        projectId: $projectId
        stateId: $stateId
        title: $title
        description: $description
      }
    ) {
      success
      issue {
        identifier
        url
        state {
          name
        }
      }
    }
  }
`;

export const TAKE_PR_ISSUE_QUERY = `
  query OrchestratorWatcherTakePrIssue($issueId: String!) {
    issue(id: $issueId) {
      identifier
      url
      state {
        name
      }
    }
  }
`;
