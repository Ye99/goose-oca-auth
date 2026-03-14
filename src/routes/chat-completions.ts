export function badRequest(error: string) {
  return Response.json(
    {
      error: {
        message: error,
        type: "invalid_request",
      },
    },
    { status: 400 },
  )
}

export function upstreamError(error: string) {
  return Response.json(
    {
      error: {
        message: error,
        type: "upstream_unavailable",
      },
    },
    { status: 502 },
  )
}
