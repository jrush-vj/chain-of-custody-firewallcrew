import morgan from 'morgan';

export const requestLogger = morgan('combined', {
  skip: (req, res) => res.statusCode < 400
});




