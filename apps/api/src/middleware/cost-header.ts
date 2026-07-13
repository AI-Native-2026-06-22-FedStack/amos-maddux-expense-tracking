import { RequestHandler } from "express";

const aiAssistUsageHeader = "AI-Assist-Usage";

export interface AiAssistUsage {
  cost: number;
  remainingQuota: number;
}

export const attachAiAssistUsageHeader: RequestHandler = (request, response, next) => {
  response.setHeader(aiAssistUsageHeader, formatAiAssistUsage(request.aiAssistUsage));

  next();
};

function formatAiAssistUsage(usage: AiAssistUsage | undefined): string {
  const cost = usage?.cost ?? 0;
  const remainingQuota = usage?.remainingQuota ?? 0;

  return `cost=${cost}; remaining=${remainingQuota}`;
}
