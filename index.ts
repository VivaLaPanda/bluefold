import bsky, { AppBskyNotificationListNotifications } from '@atproto/api';
const { BskyAgent } = bsky;
const { RichText } = bsky;
import { backOff } from "exponential-backoff";
import * as dotenv from 'dotenv';
import process from 'node:process';
dotenv.config();

import { Manifold } from 'manifold-sdk';
import { Configuration, OpenAIApi } from 'openai';
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const agent = new BskyAgent({
  service: 'https://bsky.social',
});

const manifold = new Manifold(process.env.MANIFOLD_API_KEY);

async function callGPT4(prompt: string) {
  try {
    const response = await openai.createChatCompletion({
      model: "gpt-4",
      messages: [
        {"role": "user", "content": prompt}
      ],
    })

    if (response.status === 429) {
      // Wait for 1 second and try again
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return await callGPT4(prompt);
    }

    if (response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message?.content.trim();
    } else {
      throw new Error("No response from GPT-4");
    }
  } catch (error) {
    console.error("Error calling GPT-4:", error);

    throw error;
  }
}

async function createPredictionMarket(post: any, resolver: string) {
  const post_text = post.record.text
  const date = post.record.createdAt

  const author_handle = post.author.handle

  // Convert the post into a question phrased like a prediction market
  const prompt = `Convert a post into a suitably structured question for a prediction market,
  including resolution criteria, timeline.
  As useful context when setting the market resolution dates, the current date/time is ${date} (in UTC).
  If you reference a user in the market title, preface their handle with an @ symbol.
  The response should be at most 120 characters.

  Example:
  Post: "I caught the very tail end of the hedge fund boom when it was clear that employee compensation on Wall Street was going to be structurally lower going forward than it was before the mid-2000's, and it's the same exact dynamic in Silicon Valley today."
  Author: vivalapanda.moe
  Response: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area"

  Post: "You'll be able to get one Google L5, give them GPT-4-Copilot, and have them modernize the software systems for a whole org within a year

  That means you can afford to have them work on something like improving farm automation, unlike the previously needed 10 person team"
  Author: kache.bsky.social
  Response: "Will I believe my prediction about AI enabling more SWEs to solve less lucrative problems by shrinking team sizes to have been fulfilled by EoY 2030"

  Post: "An environmental contaminant that we don't understand and won't for another decade at least responsible for this stuff, I'd bet money on it.  Blaming food or sedentary lifestyles is a cop out."
  Author: mfoldbot.bsky.social
  Response: "Will the contaminant hypothesis of modern obesity be judged true by expert consensus before 2032?"

  Post: "Testing some stuff! I'll have a bot built by the end of the week I hope!"
  Author: testing.bsky.social
  Response: "Will @testing.bsky.social have a bot built by April 21st, 2023?"

  Post: "${post_text}"
  Author: ${author_handle}
  Response:`;
  const question = await callGPT4(prompt);

  // Check if the question is too long
  if (question.length > 120) {
    throw new Error("Question is too long");
  }

  // Create the JSON from the question
  const jsonPrompt = `Create a manifold.markets prediction market JSON from a question. Do not use trailing commas. Begin your output with
    [BEGIN OUTPUT] and end it with [END OUTPUT]. Use the YYYY-DD-DDTHH:MM:SS.000Z timestamp format for the closeTime (use UTC).

    Example:
    Post: "I caught the very tail end of the hedge fund boom when it was clear that employee compensation on Wall Street was going to be structurally lower going forward than it was before the mid-2000's, and it's the same exact dynamic in Silicon Valley today."
    Question: "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area"
    [BEGIN OUTPUT]
    {
      "outcomeType": "BINARY",
      "question": "Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area",
      "closeTime": "2025-01-01T00:00:00.000Z",
      "initialProb": 50,
      "descriptionMarkdown": "Resolution fully based on the individual judgement of the following resolver."
    }
    [END OUTPUT]

    Input: ${question}
    [BEGIN OUTPUT]
  `;

  let json = await callGPT4(jsonPrompt);
  // Strip begin and end output
  json = json.replace('[BEGIN OUTPUT]', '').replace('[END OUTPUT]', '');

  console.log('json', json)

  // parse the json
  const marketJSON = JSON.parse(json);

  // Convert the closeTime string to a Date object and
  // store it as a unix timestamp
  marketJSON.closeTime = new Date(marketJSON.closeTime).getTime() / 1000;

  // Add the resolver
  marketJSON.descriptionMarkdown += "\n\nResolver: @" + resolver;
  // Add the market link to the description
  marketJSON.descriptionMarkdown += "\n\nMarket created for [this post](https://bsky.app/profile/" + post.author.handle + "/post/" + post.record.id + ")";

  const market = await manifold.createMarket(marketJSON);

  return market;
}

async function replyWithMarketLink(post: any, notif: AppBskyNotificationListNotifications.Notification, resolver: string) {
  const createMarketResp = await createPredictionMarket(post, resolver);

  // wait 5 seconds
  await new Promise((resolve) => setTimeout(resolve, 5000));
  
  // Get a link for the market
  const fullMarket = await manifold.getMarket({
    slug: createMarketResp.slug,
  })

  // Use richtext to create a post that links to the market
  const rt = new RichText({text: `${fullMarket.question}: Bet on it at ${fullMarket.url}`});
  await rt.detectFacets(agent);

  // Post the reply
  await agent.post({
    text: rt.text,
    facets: rt.facets,
    reply: {
      root: {
        uri: notif.uri,
        cid: notif.cid,
      },
      parent: {
        uri: notif.uri,
        cid: notif.cid,
      },
    }
  });

  console.log('posted reply: ', rt.text, rt.facets)
}

function getResolverFromText(text: string): string | null {
  const resolverMatch = text?.match(/resolver:\s*@([\w.-]+)/i);
  return resolverMatch ? resolverMatch[1] : null;
}

async function handleMention(mention, notif: AppBskyNotificationListNotifications.Notification) {
  console.log('mention', mention);
  const postThread = await agent.getPostThread({
    uri: mention.parent.uri,
  });

  if (postThread.success) {
    const mentionRecord = notif.record as any
    const resolver = getResolverFromText(mentionRecord.text) || notif.author.handle;
    await replyWithMarketLink(postThread.data?.thread?.post, notif, resolver);
  }
}

async function handleMarketResolution(reply: { text: string; }, notif: AppBskyNotificationListNotifications.Notification) {
  const resolutionMatch = reply.text.match(/Resolve:\s*(Yes|No|n\/a)/i);
  if (resolutionMatch) {
    const resolution = resolutionMatch[1].toLowerCase();
    console.log(`Market resolution: ${resolution}`);
    // Call the Manifold API to resolve the market here
  } else {
    console.log('Invalid resolution format');
  }
}

async function listenForMentions() {
  // Loop forever until the process is killed
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // listen for mentions using listNotifications
    let response_notifs
    try {
      response_notifs = await agent.listNotifications()
    } catch (e) {
      console.log('error', e)
      // wait 1 minute before trying again
      await new Promise((resolve) => setTimeout(resolve, 60000));
      continue
    }
    const notifs = response_notifs.data.notifications

    // Mark all these notifs as read

    // Count the number of notifications which are unread
    // and which are also mentions
    const unread_mentions = notifs.filter(notif => {
      return (
        (notif.reason === 'mention' || notif.reason === 'reply') &&
        notif.isRead === false
      )
    })
    if (notifs.length > 0) {
      // console.log('notifs', notifs)
    }
    if (unread_mentions.length > 0) {
      console.log(`Found ${unread_mentions.length} new mentions.`)
    }

    unread_mentions.map(async notif => {
      console.log(`Responding to ${notif.uri}`)
      console.log('notif', notif)

      const record = notif.record as any
      
      // if record.reply has no parent, skip it
      if (!record?.reply?.parent) {
        console.log('skipping')
        return
      }

      // if record.text doesn't include our handle, skip it
      if (!record.text.includes(process.env.BSKY_USERNAME)) {
        console.log('skipping')
        return
      }
      
      if (notif.reason === 'reply' && record.reply.parent.author.handle === process.env.BSKY_USERNAME) {
        await handleMarketResolution(record.reply, notif);
      } else {
        await handleMention(record.reply, notif);
      }
    })

    // Only update notifs after we've successfully handled them
    agent.updateSeenNotifications()

    // Wait 30 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}

// function to test callgpt4
async function testCallGpt4() {
  const prompt = 'Will real 75th percentile software engineer comp be higher than today in 2025 in The Bay Area';
  const question = await callGPT4(prompt);
  console.log('question', question)
}

async function main() {
  // login to the agent
  if (!process.env.BSKY_USERNAME || !process.env.BSKY_PASSWORD) {
    throw new Error('BSKY_USERNAME and BSKY_PASSWORD must be set in the environment');
  }

  const username = process.env.BSKY_USERNAME;
  const password = process.env.BSKY_PASSWORD;

  // login to the agent. If it fails, do exponential backoff
  await backOff(() => agent.login({ identifier: username, password: password }), { maxDelay: 60000, numOfAttempts: 10 });

  // await testCallGpt4();
  await listenForMentions();
}

main().catch(error => {
  console.error('Error in main function:', error);
});
