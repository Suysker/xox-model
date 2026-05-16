import type { FastifyReply } from 'fastify'

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function notFound(message: string) {
  return new ApiError(404, message)
}

export function forbidden(message = 'Forbidden') {
  return new ApiError(403, message)
}

export function conflict(message: string) {
  return new ApiError(409, message)
}

export function unprocessable(message: string) {
  return new ApiError(422, message)
}

export function unauthorized(message = 'Not authenticated') {
  return new ApiError(401, message)
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send({ detail: error.message })
  }

  throw error
}
