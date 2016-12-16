var Constants = {
  HttpConstants: {
    /**
     * Http Verbs
     *
     * @const
     */
    HttpVerbs: {
      PUT: 'PUT',
      GET: 'GET',
      DELETE: 'DELETE',
      POST: 'POST',
      HEAD: 'HEAD'
    },

    /**
     * Response codes
     *
     * @const
     */
    HttpResponseCodes: {
      Ok: 200,
      Created: 201,
      Accepted: 202,
      NoContent: 204,
      BadRequest: 400,
      Unauthorized: 401,
      Forbidden: 403,
      NotFound: 404,
      Conflict: 409
    }
  },
}

module.exports = Constants;