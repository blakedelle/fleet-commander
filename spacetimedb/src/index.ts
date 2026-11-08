import { schema, table, t } from 'spacetimedb/server';

/* const spacetimedb = schema({
  person: table(
    { public: true },
    {
      name: t.string(),
    }
  ),
}); */
const spacetimedb = schema({
  robot: table(
    { public: true },
    {
      robot_id: t.string().primaryKey(),
      status: t.string(),      // "ONLINE", "WARN", or "ERROR"
      battery: t.f64(),
      location_x: t.f64(),
      location_y: t.f64(),
    }
  ),
});

export default spacetimedb;

/* export const init = spacetimedb.init(_ctx => {
  // Called when the module is initially published
});

export const onConnect = spacetimedb.clientConnected(_ctx => {
  // Called every time a new client connects
});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {
  // Called every time a client disconnects
}); */

/* export const add = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    ctx.db.person.insert({ name });
  }
);

export const sayHello = spacetimedb.reducer(ctx => {
  for (const person of ctx.db.person.iter()) {
    console.info(`Hello, ${person.name}!`);
  }
  console.info('Hello, World!');
}); */
export const update_robot = spacetimedb.reducer(
  {
    robot_id: t.string(),
    status: t.string(),
    battery: t.f64(),
    location_x: t.f64(),
    location_y: t.f64(),
  },
  (ctx, args) => {
    const existing = ctx.db.robot.robot_id.find(args.robot_id);
    if (existing) {
      ctx.db.robot.robot_id.update({ ...args });
    } else {
      ctx.db.robot.insert({ ...args });
    }
  }
);
